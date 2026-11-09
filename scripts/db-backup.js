'use strict';

/**
 * Backs up both logical PostgreSQL databases into ./backups.
 * Passwords are passed only through the existing container environment; they
 * are never printed.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadEnv } = require('./lib/load-env');

loadEnv();

const ROOT = path.resolve(__dirname, '..');
const BACKUPS = path.join(ROOT, 'backups');
const ADMIN_USER = process.env.POSTGRES_ADMIN_USER || 'postgres';
const DATABASES = [
  { name: process.env.AWS_DB_NAME || 'aws_library', label: 'aws' },
  { name: process.env.RENDER_DB_NAME || 'render_library', label: 'render' }
];

fs.mkdirSync(BACKUPS, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

for (const database of DATABASES) {
  const file = path.join(BACKUPS, `${database.name}-${stamp}.sql`);
  const result = spawnSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '-U',
      ADMIN_USER,
      '-d',
      database.name,
      '--no-owner',
      '--clean',
      '--if-exists'
    ],
    { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }
  );

  if (result.error) {
    console.error(`Backup failed for ${database.name}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`pg_dump failed for ${database.name}:`);
    console.error(result.stderr ? result.stderr.toString('utf8') : 'unknown error');
    process.exit(result.status || 1);
  }

  fs.writeFileSync(file, result.stdout, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows may not support POSIX modes.
  }
  console.log(`Backed up ${database.name} -> ${path.relative(ROOT, file)} (${result.stdout.length} bytes)`);
}

console.log('Backup complete. Backups may contain application data; keep them private.');
