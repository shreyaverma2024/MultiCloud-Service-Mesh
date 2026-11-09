'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { poolConfig } = require('../../shared/db');

const MANAGED_KEYS = [
  'DB_SSL',
  'DB_SSL_REJECT_UNAUTHORIZED',
  'DB_SSL_CA_PATH',
  'DB_SSL_CA_PEM',
  'DB_SSL_SERVERNAME',
  'POSTGRES_HOST',
  'POSTGRES_PORT'
];

let savedEnv;
let tempDir;

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_KEYS) savedEnv[key] = process.env[key];

  process.env.TEST_DB_NAME = 'test_db';
  process.env.TEST_DB_USER = 'test_user';
  process.env.TEST_DB_PASSWORD = 'test_password';
  delete process.env.DB_SSL;
  delete process.env.DB_SSL_REJECT_UNAUTHORIZED;
  delete process.env.DB_SSL_CA_PATH;
  delete process.env.DB_SSL_CA_PEM;
  delete process.env.DB_SSL_SERVERNAME;
  delete process.env.POSTGRES_HOST;
  delete process.env.POSTGRES_PORT;

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-db-test-'));
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('TLS is disabled by default for local development', () => {
  const config = poolConfig('TEST');
  expect(config.ssl).toBe(false);
});

test('TLS verification is enabled by default when DB_SSL is true', () => {
  process.env.DB_SSL = 'true';
  const config = poolConfig('TEST');
  expect(config.ssl).toEqual({ rejectUnauthorized: true });
});

test('a CA file is loaded and used for verification', () => {
  const caPath = path.join(tempDir, 'ca.crt');
  const caPem = '-----BEGIN CERTIFICATE-----\nTEST-CA\n-----END CERTIFICATE-----\n';
  fs.writeFileSync(caPath, caPem);

  process.env.DB_SSL = 'true';
  process.env.DB_SSL_CA_PATH = caPath;

  const config = poolConfig('TEST');
  expect(config.ssl.rejectUnauthorized).toBe(true);
  expect(config.ssl.ca).toBe(caPem);
});

test('an inline PEM value is accepted with escaped newlines', () => {
  process.env.DB_SSL = 'true';
  process.env.DB_SSL_CA_PEM =
    '-----BEGIN CERTIFICATE-----\\nTEST-CA\\n-----END CERTIFICATE-----';

  const config = poolConfig('TEST');
  expect(config.ssl.ca).toBe(
    '-----BEGIN CERTIFICATE-----\nTEST-CA\n-----END CERTIFICATE-----'
  );
});

test('an explicit verification opt-out is preserved for the warning path', () => {
  process.env.DB_SSL = 'true';
  process.env.DB_SSL_REJECT_UNAUTHORIZED = 'false';

  const config = poolConfig('TEST');
  expect(config.ssl.rejectUnauthorized).toBe(false);
});

test('an explicit TLS server name is passed to the driver', () => {
  process.env.DB_SSL = 'true';
  process.env.DB_SSL_SERVERNAME = 'postgres.internal.example';

  const config = poolConfig('TEST');
  expect(config.ssl.servername).toBe('postgres.internal.example');
});

test('an unreadable CA path fails with a clear error', () => {
  process.env.DB_SSL = 'true';
  process.env.DB_SSL_CA_PATH = path.join(tempDir, 'missing-ca.crt');

  expect(() => poolConfig('TEST')).toThrow('DB_SSL_CA_PATH could not be read');
});
