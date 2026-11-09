'use strict';

/**
 * Creates the local .env file from .env.example.
 *
 * - Every __GENERATE__ placeholder is replaced with a cryptographically random
 *   32-byte hex value.
 * - Secret VALUES are never printed to the console.
 * - An existing .env is never overwritten unless --force is supplied, because
 *   regenerating database passwords after the PostgreSQL volume exists would
 *   lock the services out of their databases.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const EXAMPLE = path.join(ROOT, '.env.example');
const TARGET = path.join(ROOT, '.env');
const force = process.argv.includes('--force');

if (!fs.existsSync(EXAMPLE)) {
  console.error('Cannot find .env.example. Run this script from the project root.');
  process.exit(1);
}

if (fs.existsSync(TARGET) && !force) {
  console.log('.env already exists. It was not modified.');
  console.log('Use "node scripts/init-secrets.js --force" only if you also intend to recreate the database volume.');
  process.exit(0);
}

const source = fs.readFileSync(EXAMPLE, 'utf8');
const generatedNames = [];

const output = source
  .split(/\r?\n/)
  .map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) return line;
    if (match[2] !== '__GENERATE__') return line;
    generatedNames.push(match[1]);
    return `${match[1]}=${crypto.randomBytes(32).toString('hex')}`;
  })
  .join('\n');

if (output.includes('__GENERATE__')) {
  console.error('Refusing to write .env: at least one __GENERATE__ placeholder was not replaced.');
  process.exit(1);
}

fs.writeFileSync(TARGET, output, { mode: 0o600 });
try {
  fs.chmodSync(TARGET, 0o600);
} catch {
  // Windows does not always support POSIX modes. The file is still local-only.
}

console.log(`Created .env with ${generatedNames.length} generated secret values.`);
console.log(`Variables generated: ${generatedNames.join(', ')}`);
console.log('No secret values were printed.');
if (force) {
  console.log('WARNING: --force was used. If the PostgreSQL volume already exists, recreate it with "docker compose down -v".');
}
