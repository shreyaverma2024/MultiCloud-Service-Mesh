'use strict';

/**
 * Environment configuration helpers.
 *
 * Startup validation deliberately reports only the NAMES of missing variables.
 * It never prints values, because several variables contain secrets.
 */

function readEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function requireEnv(names, component) {
  const missing = names.filter((name) => !readEnv(name));
  if (missing.length > 0) {
    // Deliberately no values in the output.
    console.error(
      JSON.stringify({
        level: 'fatal',
        component: component || 'unknown',
        event: 'configuration_invalid',
        missing
      })
    );
    process.exit(1);
  }
}

function requireSecrets(names, component, minimumLength = 16) {
  requireEnv(names, component);
  const tooShort = names.filter((name) => (readEnv(name) || '').length < minimumLength);
  if (tooShort.length > 0) {
    console.error(
      JSON.stringify({
        level: 'fatal',
        component: component || 'unknown',
        event: 'secret_too_short',
        variables: tooShort
      })
    );
    process.exit(1);
  }
}

function optionalEnv(name, fallback) {
  const value = readEnv(name);
  return value === undefined ? fallback : value;
}

function intEnv(name, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function boolEnv(name, fallback = false) {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function numberEnv(name, fallback) {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

module.exports = {
  readEnv,
  requireEnv,
  requireSecrets,
  optionalEnv,
  intEnv,
  boolEnv,
  numberEnv
};
