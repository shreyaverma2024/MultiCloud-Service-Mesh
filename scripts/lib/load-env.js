'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Tiny .env loader for host-side helper scripts. It deliberately does not
 * print values and never overrides variables that are already set in the
 * process environment.
 */
function parseEnvFile(filePath) {
  const output = {};
  if (!fs.existsSync(filePath)) return output;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    output[key] = value;
  }
  return output;
}

function loadEnv(filePath = path.resolve(__dirname, '..', '..', '.env')) {
  const values = parseEnvFile(filePath);
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return values;
}

module.exports = { parseEnvFile, loadEnv };
