'use strict';

const express = require('express');
const {
  config,
  logger,
  respond,
  errors,
  validate,
  metrics,
  db,
  auth,
  requestId,
  securityHeaders,
  asyncHandler
} = require('@mesh/shared');
const { MeshStore, VALID_SEVERITIES, VALID_KINDS } = require('./store');

const COMPONENT = 'control-plane';
const log = logger.child(COMPONENT);

config.requireSecrets(
  ['AWS_DB_PASSWORD', 'CONTROL_PLANE_ADMIN_TOKEN', 'CONTROL_PLANE_SERVICE_TOKEN', 'CONTROL_PLANE_READ_TOKEN'],
  COMPONENT
);
config.requireEnv(
  ['AWS_DB_NAME', 'AWS_DB_USER', 'POSTGRES_HOST', 'CONTROL_PLANE_ADMIN_TOKEN', 'CONTROL_PLANE_SERVICE_TOKEN', 'CONTROL_PLANE_READ_TOKEN'],
  COMPONENT
);

const PORT = config.intEnv('CONTROL_PLANE_PORT', 4000, 1, 65535);
const STALE_MS = config.intEnv('COMPONENT_STALE_MS', 12000, 3000, 300000);
const MODE = config.optionalEnv('MESH_MODE', 'split') === 'bundle' ? 'bundle' : 'split';

const secrets = {
  admin: config.readEnv('CONTROL_PLANE_ADMIN_TOKEN'),
  service: config.readEnv('CONTROL_PLANE_SERVICE_TOKEN'),
  read: config.readEnv('CONTROL_PLANE_READ_TOKEN')
};

const pool = db.createPool('AWS', COMPONENT);
const stats = new metrics.Metrics(COMPONENT);
const store = new MeshStore({ pool, staleMs: STALE_MS, mode: MODE, log });

function recordAuthFailure(info) {
  store.recordEvent({
    severity: 'warn',
    source: 'control-plane',
    cloud: 'aws',
    type: 'auth_failure',
    message: 'An unauthenticated or unauthorized request was rejected',
    details: {
      path: info.path,
      method: info.method,
      requestId: info.requestId,
      suppliedScope: info.scope || 'none'
    }
  });
}

const serviceOnly = auth.requireScope(['service', 'admin'], secrets, { onFailure: recordAuthFailure });
const adminOnly = auth.requireScope(['admin'], secrets, { onFailure: recordAuthFailure });
const readOnly = auth.requireScope(['read', 'admin'], secrets, { onFailure: recordAuthFailure });
const serviceOrRead = auth.requireScope(['service', 'read', 'admin'], secrets, { onFailure: recordAuthFailure });

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(requestId);
app.use(express.json({ limit: '200kb' }));

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

app.get('/health', (req, res) => {
  return respond.ok(res, {
    component: COMPONENT,
    status: 'healthy',
    cloud: 'aws',
    mode: MODE,
    database: { connected: store.dbConnected, lastError: store.lastDbError },
    registrySize: store.components.size,
    expectedComponents: store.expected.length,
    startedAt: store.startedAt
  });
});

app.get('/metrics', readOnly, (req, res) => {
  return respond.ok(res, {
    ...stats.snapshot(),
    registrySize: store.components.size,
    eventCount: store.events.length,
    databaseConnected: store.dbConnected,
    mode: MODE
  });
});

app.post('/api/registry/register', serviceOnly, (req, res) => {
  const id = validate.stringField(req.body.id, 'id', { min: 2, max: 80 });
  if (!/^[a-z0-9-]+$/.test(id)) {
    return respond.fail(res, 400, 'VALIDATION_ERROR', 'id must contain only lowercase letters, digits and hyphens');
  }
  const name = validate.stringField(req.body.name, 'name', { min: 2, max: 120 });
  const kind = req.body.kind || 'service';
  if (!VALID_KINDS.has(kind)) {
    return respond.fail(res, 400, 'VALIDATION_ERROR', `kind must be one of: ${[...VALID_KINDS].join(', ')}`);
  }
  const cloud = req.body.cloud === 'render' ? 'render' : 'aws';
  const role = validate.stringField(req.body.role, 'role', { min: 1, max: 60 });
  const baseUrl = req.body.baseUrl ? validate.stringField(req.body.baseUrl, 'baseUrl', { max: 500 }) : null;
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
    return respond.fail(res, 400, 'VALIDATION_ERROR', 'baseUrl must start with http:// or https://');
  }
  const record = store.register({
    id,
    name,
    kind,
    cloud,
    role,
    baseUrl,
    version: req.body.version,
    startedAt: req.body.startedAt,
    meta: typeof req.body.meta === 'object' && req.body.meta ? req.body.meta : {},
    status: 'healthy'
  });
  return respond.ok(res, store.publicComponent(record), { requestId: req.id }, 201);
});

app.post('/api/registry/heartbeat', serviceOnly, (req, res) => {
  const id = validate.stringField(req.body.id, 'id', { min: 2, max: 80 });
  const record = store.heartbeat({
    id,
    status: req.body.status,
    metrics: typeof req.body.metrics === 'object' && req.body.metrics ? req.body.metrics : {},
    meta: typeof req.body.meta === 'object' && req.body.meta ? req.body.meta : {},
    configVersion: req.body.configVersion
  });
  if (!record) {
    return respond.fail(res, 404, 'COMPONENT_NOT_REGISTERED', 'Register the component before sending heartbeats');
  }
  return respond.ok(res, { id, acknowledgedAt: new Date().toISOString() });
});

app.post('/api/registry/deregister', serviceOnly, (req, res) => {
  const id = validate.stringField(req.body.id, 'id', { min: 2, max: 80 });
  const removed = store.deregister(id, req.body.reason || 'graceful_shutdown');
  return respond.ok(res, { id, removed });
});

app.delete('/api/registry/:id', adminOnly, (req, res) => {
  const id = validate.stringField(req.params.id, 'id', { min: 2, max: 80 });
  const removed = store.deregister(id, 'admin_request');
  if (!removed) return respond.fail(res, 404, 'COMPONENT_NOT_FOUND', `Component ${id} is not registered`);
  return respond.ok(res, { id, removed });
});

app.get('/api/registry/services', serviceOrRead, (req, res) => {
  const components = store.listComponents({
    kind: req.query.kind,
    cloud: req.query.cloud,
    name: req.query.name
  });
  return respond.ok(res, components, { count: components.length, requestId: req.id });
});

app.get('/api/registry/services/:id', serviceOrRead, (req, res) => {
  const record = store.getComponent(req.params.id);
  if (!record) return respond.fail(res, 404, 'COMPONENT_NOT_FOUND', `Component ${req.params.id} is not registered`);
  return respond.ok(res, store.publicComponent(record), { requestId: req.id });
});

app.get('/api/routing', serviceOrRead, (req, res) => {
  return respond.ok(res, store.getBookRouting(), { requestId: req.id });
});

app.put('/api/routing/book/weights', adminOnly, (req, res) => {
  const aws = validate.intField(req.body.aws, 'aws', { min: 0, max: 100 });
  const render = validate.intField(req.body.render, 'render', { min: 0, max: 100 });
  if (aws + render !== 100) {
    return respond.fail(res, 400, 'INVALID_WEIGHTS', 'aws + render must equal 100');
  }
  const operator = req.get('x-operator') || 'admin';
  const result = store.setBookWeights(aws, render, operator);
  if (!result.ok) return respond.fail(res, 400, 'INVALID_WEIGHTS', result.reason);
  return respond.ok(res, result.routing, { requestId: req.id });
});

app.get('/api/config/sidecar/:name', serviceOnly, (req, res) => {
  const name = validate.stringField(req.params.name, 'name', { min: 2, max: 80 });
  const record = store.getComponent(name);
  return respond.ok(res, {
    version: store.routing.version,
    sidecar: name,
    registered: Boolean(record),
    config: {
      timeoutMs: config.intEnv('SIDECAR_TIMEOUT_MS', 2000, 200, 30000),
      retries: config.intEnv('SIDECAR_RETRIES', 2, 0, 5),
      retryDelayMs: config.intEnv('SIDECAR_RETRY_DELAY_MS', 100, 0, 5000),
      circuitBreaker: {
        failureThreshold: config.intEnv('SIDECAR_BREAKER_FAILURES', 5, 1, 100),
        successThreshold: config.intEnv('SIDECAR_BREAKER_SUCCESSES', 2, 1, 20),
        cooldownMs: config.intEnv('SIDECAR_BREAKER_COOLDOWN_MS', 10000, 1000, 300000),
        halfOpenMaxCalls: 1
      }
    },
    routing: { book: { ...store.routing.book }, version: store.routing.version }
  });
});

app.get('/api/mesh/status', readOnly, (req, res) => {
  return respond.ok(res, store.buildStatus({ controlPlaneMetrics: stats.snapshot() }), {
    requestId: req.id
  });
});

app.get('/api/alerts', readOnly, (req, res) => {
  const status = store.buildStatus({ controlPlaneMetrics: stats.snapshot() });
  return respond.ok(res, status.alerts, { count: status.alerts.length, requestId: req.id });
});

app.get('/api/events', readOnly, (req, res) => {
  const severity = req.query.severity ? validate.stringField(req.query.severity, 'severity', { max: 20 }) : undefined;
  if (severity && !VALID_SEVERITIES.has(severity)) {
    return respond.fail(res, 400, 'VALIDATION_ERROR', `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}`);
  }
  const limit = validate.intQuery(req.query.limit, 'limit', { fallback: 200, min: 1, max: 1000 });
  const events = store.getEvents({
    severity,
    source: req.query.source ? validate.stringField(req.query.source, 'source', { max: 80 }) : undefined,
    cloud: req.query.cloud ? validate.stringField(req.query.cloud, 'cloud', { max: 20 }) : undefined,
    type: req.query.type ? validate.stringField(req.query.type, 'type', { max: 80 }) : undefined,
    since: req.query.since ? validate.stringField(req.query.since, 'since', { max: 40 }) : undefined,
    limit
  });
  return respond.ok(res, events, { count: events.length, requestId: req.id });
});

app.post('/api/events', serviceOnly, (req, res) => {
  const severity = req.body.severity || 'info';
  if (!VALID_SEVERITIES.has(severity)) {
    return respond.fail(res, 400, 'VALIDATION_ERROR', `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}`);
  }
  const event = store.recordEvent({
    severity,
    source: req.body.source ? String(req.body.source).slice(0, 80) : 'unknown',
    cloud: req.body.cloud === 'render' ? 'render' : 'aws',
    type: req.body.type ? String(req.body.type).slice(0, 80) : 'generic_event',
    message: req.body.message ? String(req.body.message).slice(0, 1000) : '',
    details: typeof req.body.details === 'object' && req.body.details ? req.body.details : {}
  });
  return respond.ok(res, event, { requestId: req.id }, 201);
});

app.use(errors.notFoundHandler);
app.use(errors.errorHandler(log));

const sweepTimer = setInterval(() => store.sweep(), 2000);
sweepTimer.unref();

let dbInitBusy = false;
async function tryInitializeDatabase() {
  if (dbInitBusy || store.dbConnected) return;
  dbInitBusy = true;
  try {
    await store.initializeDatabase();
  } finally {
    dbInitBusy = false;
  }
}

// The Control Plane keeps working in memory if PostgreSQL disappears. This
// timer reconnects automatically once the database is available again.
const dbWatchTimer = setInterval(() => {
  if (!store.dbConnected) void tryInitializeDatabase();
}, 15000);
dbWatchTimer.unref();

const server = app.listen(PORT, '0.0.0.0', async () => {
  log.info('listening', { port: PORT, cloud: 'aws', mode: MODE, staleMs: STALE_MS });
  await tryInitializeDatabase();
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown_started', { signal });
  clearInterval(sweepTimer);
  clearInterval(dbWatchTimer);
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled_rejection', { message: reason instanceof Error ? reason.message : String(reason) });
});
