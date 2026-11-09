'use strict';

const { optionalEnv } = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Header / field names that must never appear in logs.
const SENSITIVE_KEY = /authorization|api[-_]?key|token|secret|password|cookie|signature|private[-_]?key/i;

function redact(value, depth = 0) {
  if (depth > 4) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(item, depth + 1);
    }
    return output;
  }
  return value;
}

function write(level, component, event, fields) {
  const threshold = LEVELS[optionalEnv('LOG_LEVEL', 'info')] || LEVELS.info;
  if (LEVELS[level] < threshold) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    event,
    ...(fields ? redact(fields) : {})
  };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

function child(component) {
  return {
    debug: (event, fields) => write('debug', component, event, fields),
    info: (event, fields) => write('info', component, event, fields),
    warn: (event, fields) => write('warn', component, event, fields),
    error: (event, fields) => write('error', component, event, fields)
  };
}

module.exports = { child, redact };
