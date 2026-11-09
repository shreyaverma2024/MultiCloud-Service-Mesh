'use strict';

const fs = require('node:fs');
const { Pool } = require('pg');
const { boolEnv, intEnv, readEnv } = require('./config');
const logger = require('./logger');

/**
 * PostgreSQL helper. One self-managed server hosts two logical databases:
 *   AWS    -> aws_library
 *   Render -> render_library
 *
 * TLS is optional locally (private Docker network) and required for the cloud
 * deployment. Certificate verification is ON by default. A self-managed CA can
 * be trusted with DB_SSL_CA_PATH or DB_SSL_CA_PEM; do not disable verification
 * unless you have read docs/SECURITY.md and accept the documented risk.
 */

function readCaCertificate() {
  const inlinePem = readEnv('DB_SSL_CA_PEM');
  if (inlinePem) {
    // Environment files often store multi-line PEM values with literal \n.
    return inlinePem.replace(/\\n/g, '\n');
  }

  const caPath = readEnv('DB_SSL_CA_PATH');
  if (!caPath) return undefined;

  try {
    return fs.readFileSync(caPath, 'utf8');
  } catch (error) {
    throw new Error(`DB_SSL_CA_PATH could not be read: ${error.message}`);
  }
}

function poolConfig(prefix) {
  const database = readEnv(`${prefix}_DB_NAME`);
  const user = readEnv(`${prefix}_DB_USER`);
  const password = readEnv(`${prefix}_DB_PASSWORD`);
  if (!database || !user || !password) {
    throw new Error(`Database configuration for ${prefix} is incomplete`);
  }

  const sslEnabled = boolEnv('DB_SSL', false);
  const rejectUnauthorized = boolEnv('DB_SSL_REJECT_UNAUTHORIZED', true);
  const ca = sslEnabled ? readCaCertificate() : undefined;
  const servername = readEnv('DB_SSL_SERVERNAME');

  return {
    host: readEnv('POSTGRES_HOST') || 'postgres',
    port: intEnv('POSTGRES_PORT', 5432, 1, 65535),
    database,
    user,
    password,
    ssl: sslEnabled
      ? {
          rejectUnauthorized,
          ...(ca ? { ca } : {}),
          ...(servername ? { servername } : {})
        }
      : false,
    max: intEnv('DB_POOL_MAX', 10, 1, 50),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: intEnv('DB_CONNECT_TIMEOUT_MS', 4000, 500, 30000),
    application_name: `mesh-${prefix.toLowerCase()}`
  };
}

function createPool(prefix, componentName = 'db') {
  const log = logger.child(componentName);
  const config = poolConfig(prefix);

  if (config.ssl && config.ssl.rejectUnauthorized === false) {
    // Make this loud: disabling verification is never silent.
    log.warn('db_tls_verification_disabled', {
      hint:
        'Set DB_SSL_REJECT_UNAUTHORIZED=true and configure DB_SSL_CA_PATH ' +
        'or DB_SSL_CA_PEM to verify the PostgreSQL server certificate.'
    });
  }

  const pool = new Pool(config);
  pool.on('error', (error) => {
    log.error('postgres_pool_error', { message: error.message });
  });
  return pool;
}

async function ping(pool) {
  const result = await pool.query('SELECT 1 AS ok');
  return result.rows[0] && result.rows[0].ok === 1;
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is more useful than a rollback failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { createPool, ping, withTransaction, poolConfig };
