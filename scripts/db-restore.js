'use strict';

/**
 * Restores a plain SQL backup produced by scripts/db-backup.js.
 *
 * Usage:
 *   node scripts/db-restore.js backups/aws_library-....sql --database aws_library --yes
 *
 * The --yes flag is required because this overwrites the target database.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadEnv } = require('./lib/load-env');

loadEnv();

const args = process.argv.slice(2);
const fileArg = args.find((value) => !value.startsWith('--'));
const databaseIndex = args.indexOf('--database');
const databaseArg = databaseIndex >= 0 ? args[databaseIndex + 1] : undefined;
const confirmed = args.includes('--yes');

if (!fileArg || !confirmed) {
  console.error('Usage: node scripts/db-restore.js <backup.sql> [--database <name>] --yes');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const BACKUPS = path.join(ROOT, 'backups');
const file = path.resolve(ROOT, fileArg);
if (!file.startsWith(BACKUPS + path.sep)) {
  console.error('Refusing to restore from outside the backups/ directory.');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`Backup file not found: ${fileArg}`);
  process.exit(1);
}

const baseName = path.basename(file);
const inferred = baseName.startsWith((process.env.RENDER_DB_NAME || 'render_library') + '-')
  ? process.env.RENDER_DB_NAME || 'render_library'
  : process.env.AWS_DB_NAME || 'aws_library';
const database = databaseArg || inferred;
const adminUser = process.env.POSTGRES_ADMIN_USER || 'postgres';

console.log(`Restoring ${fileArg} into ${database} ...`);
const result = spawnSync(
  'docker',
  [
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    adminUser,
    '-d',
    database
  ],
  { cwd: ROOT, input: fs.readFileSync(file), encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }
);

if (result.error) {
  console.error(`Restore failed: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(result.stderr ? result.stderr.toString('utf8') : 'Restore failed.');
  process.exit(result.status || 1);
}

console.log(`Restore complete for ${database}.`);
