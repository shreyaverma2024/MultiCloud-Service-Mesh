'use strict';

const express = require('express');
const { createClient } = require('redis');
const {
  config,
  logger,
  respond,
  errors,
  validate,
  metrics,
  auth,
  meshAgent,
  requestId,
  securityHeaders,
  asyncHandler
} = require('@mesh/shared');

const COMPONENT = 'cache-api';
const log = logger.child(COMPONENT);

config.requireSecrets(['REDIS_PASSWORD', 'CACHE_API_KEY', 'CONTROL_PLANE_SERVICE_TOKEN'], COMPONENT);
config.requireEnv(
  ['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'CACHE_API_KEY', 'CONTROL_PLANE_URL'],
  COMPONENT
);

const PORT = config.intEnv('CACHE_API_PORT', 4100, 1, 65535);
const REDIS_HOST = config.readEnv('REDIS_HOST');
const REDIS_PORT = config.intEnv('REDIS_PORT', 6379, 1, 65535);
const REDIS_PASSWORD = config.readEnv('REDIS_PASSWORD');
const DEFAULT_TTL = config.intEnv('CACHE_DEFAULT_TTL_SECONDS', 60, 1, 86400);
const MAX_TTL = config.intEnv('CACHE_MAX_TTL_SECONDS', 3600, 1, 86400);
const NAMESPACE_PATTERN = /^[a-zA-Z0-9:_-]+$/;

const stats = new metrics.Metrics(COMPONENT);

const redis = createClient({
  url: `redis://:${encodeURIComponent(REDIS_PASSWORD)}@${REDIS_HOST}:${REDIS_PORT}`,
  socket: {
    connectTimeout: 3000,
    reconnectStrategy: (retries) => Math.min(3000, 200 + retries * 200)
  }
});

let redisConnected = false;
let redisAvailable = false;
let redisLatencyMs = null;
let lastError = null;
let lastErrorAt = null;
let lastPingAt = null;
let reconnectTimer = null;

redis.on('ready', () => {
  const wasAvailable = redisAvailable;
  redisConnected = true;
  redisAvailable = true;
  lastError = null;
  log.info('redis_ready', { host: REDIS_HOST, port: REDIS_PORT });
  if (!wasAvailable) {
    agent.reportEvent({
      severity: 'info',
      type: 'redis_recovered',
      message: 'Redis became available through the Cache API',
      details: { host: REDIS_HOST, port: REDIS_PORT }
    });
  }
});

redis.on('error', (error) => {
  const wasAvailable = redisAvailable;
  redisAvailable = false;
  lastError = error.message;
  lastErrorAt = new Date().toISOString();
  stats.inc('redis_errors');
  if (wasAvailable) {
    log.warn('redis_unavailable', { message: error.message });
    agent.reportEvent({
      severity: 'error',
      type: 'redis_unavailable',
      message: 'Redis became unavailable. Consumers must fall back to PostgreSQL.',
      details: { message: error.message }
    });
  }
});

redis.on('end', () => {
  redisConnected = false;
  redisAvailable = false;
});

async function connectRedis() {
  try {
    if (!redis.isOpen) await redis.connect();
    redisConnected = true;
  } catch (error) {
    redisConnected = false;
    redisAvailable = false;
    lastError = error.message;
    lastErrorAt = new Date().toISOString();
    stats.inc('redis_connection_failures');
    log.warn('redis_connect_failed', { message: error.message });
    reconnectTimer = setTimeout(() => {
      void connectRedis();
    }, 3000);
    reconnectTimer.unref();
  }
}

async function pingRedis() {
  if (!redis.isReady) {
    redisAvailable = false;
    return;
  }
  const startedAt = Date.now();
  try {
    await redis.ping();
    redisLatencyMs = Date.now() - startedAt;
    redisConnected = true;
    redisAvailable = true;
    lastPingAt = new Date().toISOString();
  } catch (error) {
    redisAvailable = false;
    lastError = error.message;
    lastErrorAt = new Date().toISOString();
  }
}

function redisUnavailable(res) {
  stats.inc('errors');
  return respond.fail(res, 503, 'CACHE_UNAVAILABLE', 'Redis is unavailable. Callers must use the authoritative database.', {
    redis: { available: false, lastError, lastErrorAt }
  });
}

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(requestId);
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    stats.recordRequest(res.statusCode, durationMs);
    log.info('request_completed', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100
    });
  });
  next();
});

const apiKeyAuth = auth.requireApiKey(config.readEnv('CACHE_API_KEY'), 'x-api-key', {
  onFailure: (info) => {
    agent.reportEvent({
      severity: 'warn',
      type: 'auth_failure',
      message: 'Unauthorized Cache API request rejected',
      details: info
    });
  }
});

app.get('/health', asyncHandler(async (req, res) => {
  await pingRedis();
  return respond.ok(res, {
    component: COMPONENT,
    status: redisAvailable ? 'healthy' : 'degraded',
    cloud: 'aws',
    redis: {
      available: redisAvailable,
      connected: redisConnected,
      host: REDIS_HOST,
      port: REDIS_PORT,
      latencyMs: redisLatencyMs,
      lastPingAt,
      lastError,
      lastErrorAt
    }
  });
}));

app.get('/metrics', apiKeyAuth, (req, res) => {
  const snapshot = stats.snapshot();
  const hits = snapshot.counters.hits || 0;
  const misses = snapshot.counters.misses || 0;
  return respond.ok(res, {
    ...snapshot,
    redis: {
      available: redisAvailable,
      connected: redisConnected,
      latencyMs: redisLatencyMs,
      lastPingAt,
      lastError,
      lastErrorAt
    },
    hitRatio: hits + misses > 0 ? Math.round((hits / (hits + misses)) * 10000) / 100 : 0
  });
});

app.get('/cache/:namespace/:key', apiKeyAuth, asyncHandler(async (req, res) => {
  const namespace = validate.stringField(req.params.namespace, 'namespace', { max: 80 });
  const key = validate.stringField(req.params.key, 'key', { max: 200 });
  if (!NAMESPACE_PATTERN.test(namespace)) {
    return respond.fail(res, 400, 'VALIDATION_ERROR', 'namespace contains invalid characters');
  }
  if (!redis.isReady) return redisUnavailable(res);

  const redisKey = `${namespace}:${key}`;
  try {
    const value = await redis.get(redisKey);
    stats.inc('redis_commands');
    if (value === null) {
      stats.inc('misses');
      return respond.ok(res, { hit: false, value: null, key: redisKey });
    }
    stats.inc('hits');
    let parsed = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      // Non-JSON values are returned as strings.
    }
    const ttl = await redis.ttl(redisKey);
    return respond.ok(res, { hit: true, value: parsed, ttlSeconds: ttl, key: redisKey });
  } catch (error) {
    return redisUnavailable(res);
  }
}));

app.put('/cache/:namespace/:key', apiKeyAuth, asyncHandler(async (req, res) => {
  const namespace = validate.stringField(req.params.namespace, 'namespace', { max: 80 });
  const key = validate.stringField(req.params.key, 'key', { max: 200 });
  if (!NAMESPACE_PATTERN.test(namespace)) {
    return respond.fail(res, 400, 'VALIDATION_ERROR', 'namespace contains invalid characters');
  }
  if (!Object.prototype.hasOwnProperty.call(req.body, 'value')) {
    return respond.fail(res, 400, 'VALIDATION_ERROR', 'value is required');
  }
  const ttlSeconds = req.body.ttlSeconds === undefined
    ? DEFAULT_TTL
    : validate.intField(req.body.ttlSeconds, 'ttlSeconds', { min: 1, max: MAX_TTL });
  if (!redis.isReady) return redisUnavailable(res);

  try {
    await redis.set(`${namespace}:${key}`, JSON.stringify(req.body.value), { EX: ttlSeconds });
    stats.inc('sets');
    stats.inc('redis_commands');
    return respond.ok(res, { stored: true, key: `${namespace}:${key}`, ttlSeconds });
  } catch {
    return redisUnavailable(res);
  }
}));

app.delete('/cache/:namespace/:key', apiKeyAuth, asyncHandler(async (req, res) => {
  const namespace = validate.stringField(req.params.namespace, 'namespace', { max: 80 });
  const key = validate.stringField(req.params.key, 'key', { max: 200 });
  if (!redis.isReady) return redisUnavailable(res);
  try {
    const deleted = await redis.del(`${namespace}:${key}`);
    stats.inc('deletes');
    stats.inc('redis_commands');
    return respond.ok(res, { deleted: deleted > 0, key: `${namespace}:${key}` });
  } catch {
    return redisUnavailable(res);
  }
}));

app.post('/cache/invalidate', apiKeyAuth, asyncHandler(async (req, res) => {
  const namespace = validate.stringField(req.body.namespace, 'namespace', { max: 80 });
  if (!NAMESPACE_PATTERN.test(namespace)) {
    return respond.fail(res, 400, 'VALIDATION_ERROR', 'namespace contains invalid characters');
  }
  if (!redis.isReady) return redisUnavailable(res);

  const pattern = `${namespace}:*`;
  let deleted = 0;
  try {
    const batch = [];
    for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      batch.push(key);
      if (batch.length >= 100) {
        deleted += await redis.del(batch);
        batch.length = 0;
      }
    }
    if (batch.length > 0) deleted += await redis.del(batch);
    stats.inc('invalidations');
    stats.inc('invalidated_keys', deleted);
    stats.inc('redis_commands');
    return respond.ok(res, { deleted, namespace, pattern });
  } catch {
    return redisUnavailable(res);
  }
}));

app.use(errors.notFoundHandler);
app.use(errors.errorHandler(log));

const agent = new meshAgent.MeshAgent({
  controlPlaneUrl: config.readEnv('CONTROL_PLANE_URL'),
  serviceToken: config.readEnv('CONTROL_PLANE_SERVICE_TOKEN'),
  component: {
    id: COMPONENT,
    name: 'Cache API - AWS',
    kind: 'cache',
    cloud: 'aws',
    role: 'cache-api',
    baseUrl: config.optionalEnv('CACHE_API_BASE_URL', `http://cache-api:${PORT}`),
    meta: {
      port: PORT,
      redisHost: REDIS_HOST,
      redisPort: REDIS_PORT,
      singleRedisInstance: true,
      directRedisExposure: false
    }
  },
  getStatus: () => (redisAvailable ? 'healthy' : 'degraded'),
  getMetrics: () => {
    const snapshot = stats.snapshot();
    const hits = snapshot.counters.hits || 0;
    const misses = snapshot.counters.misses || 0;
    return {
      ...snapshot,
      redisAvailable,
      hitRatio: hits + misses > 0 ? Math.round((hits / (hits + misses)) * 10000) / 100 : 0
    };
  },
  getMeta: () => ({
    redis: {
      available: redisAvailable,
      connected: redisConnected,
      host: REDIS_HOST,
      port: REDIS_PORT,
      latencyMs: redisLatencyMs,
      lastPingAt,
      lastError,
      lastErrorAt
    },
    cacheApi: { port: PORT, authenticated: true }
  })
});

const server = app.listen(PORT, '0.0.0.0', () => {
  log.info('listening', { port: PORT, cloud: 'aws' });
  agent.start();
  void connectRedis();
});

const pingTimer = setInterval(() => {
  void pingRedis();
}, 5000);
pingTimer.unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown_started', { signal });
  clearInterval(pingTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  server.close();
  await agent.stop();
  if (redis.isOpen) await redis.quit().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled_rejection', { message: reason instanceof Error ? reason.message : String(reason) });
});
