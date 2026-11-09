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
  meshAgent,
  requestId,
  securityHeaders,
  asyncHandler
} = require('@mesh/shared');

const COMPONENT = 'notification-service';
const log = logger.child(COMPONENT);

config.requireSecrets(['RENDER_DB_PASSWORD', 'CONTROL_PLANE_SERVICE_TOKEN'], COMPONENT);
config.requireEnv(
  ['RENDER_DB_NAME', 'RENDER_DB_USER', 'POSTGRES_HOST', 'CONTROL_PLANE_URL'],
  COMPONENT
);

const PORT = config.intEnv('NOTIFICATION_SERVICE_PORT', 4103, 1, 65535);
const pool = db.createPool('RENDER', COMPONENT);
const stats = new metrics.Metrics(COMPONENT);
let dbHealthy = false;
let lastDbCheck = null;

async function checkDatabase() {
  try {
    dbHealthy = await db.ping(pool);
  } catch {
    dbHealthy = false;
  }
  lastDbCheck = new Date().toISOString();
}

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(requestId);
app.use(express.json({ limit: '100kb' }));

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

app.get('/health', asyncHandler(async (req, res) => {
  await checkDatabase();
  return respond.ok(res, {
    component: COMPONENT,
    status: dbHealthy ? 'healthy' : 'unhealthy',
    cloud: 'aws',
    database: { connected: dbHealthy, databaseName: config.readEnv('RENDER_DB_NAME'), lastCheck: lastDbCheck }
  });
}));

app.get('/ready', (req, res) => {
  if (!dbHealthy) return respond.fail(res, 503, 'NOT_READY', 'Database is unavailable');
  return respond.ok(res, { ready: true });
});

app.get('/metrics', (req, res) => {
  return respond.ok(res, { ...stats.snapshot(), databaseConnected: dbHealthy });
});

app.post('/api/notifications', asyncHandler(async (req, res) => {
  const memberId = validate.intField(req.body.memberId, 'memberId');
  const bookId = validate.intField(req.body.bookId, 'bookId', { required: false });
  const type = validate.enumField(
    validate.stringField(req.body.type, 'type', { max: 20 }).toUpperCase(),
    'type',
    ['BORROW', 'RETURN', 'SYSTEM']
  );
  const message = validate.stringField(req.body.message, 'message', { min: 1, max: 1000 });
  const status = req.body.status
    ? validate.enumField(String(req.body.status).toUpperCase(), 'status', ['PENDING', 'SENT', 'FAILED'])
    : 'PENDING';

  const result = await pool.query(
    `INSERT INTO notifications (member_id, book_id, type, message, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, member_id, book_id, type, message, status, created_at, updated_at`,
    [memberId, bookId || null, type, message, status]
  );
  stats.inc('notifications_created');
  stats.inc(`notifications_${type.toLowerCase()}`);
  return respond.ok(res, result.rows[0], { requestId: req.id }, 201);
}));

app.get('/api/notifications', asyncHandler(async (req, res) => {
  const limit = validate.intQuery(req.query.limit, 'limit', { fallback: 50, min: 1, max: 200 });
  const memberId = req.query.memberId ? validate.intField(req.query.memberId, 'memberId') : null;
  const status = req.query.status
    ? validate.enumField(String(req.query.status).toUpperCase(), 'status', ['PENDING', 'SENT', 'FAILED'])
    : null;
  const type = req.query.type
    ? validate.enumField(String(req.query.type).toUpperCase(), 'type', ['BORROW', 'RETURN', 'SYSTEM'])
    : null;

  const values = [];
  const conditions = [];
  if (memberId) {
    values.push(memberId);
    conditions.push(`member_id = $${values.length}`);
  }
  if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }
  if (type) {
    values.push(type);
    conditions.push(`type = $${values.length}`);
  }
  values.push(limit);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT id, member_id, book_id, type, message, status, created_at, updated_at
     FROM notifications
     ${where}
     ORDER BY id DESC
     LIMIT $${values.length}`,
    values
  );
  stats.inc('db_queries');
  return respond.ok(res, result.rows, { count: result.rows.length, requestId: req.id });
}));

app.get('/api/notifications/:id', asyncHandler(async (req, res) => {
  const id = validate.intField(req.params.id, 'id');
  const result = await pool.query(
    `SELECT id, member_id, book_id, type, message, status, created_at, updated_at
     FROM notifications WHERE id = $1`,
    [id]
  );
  stats.inc('db_queries');
  if (result.rows.length === 0) {
    return respond.fail(res, 404, 'NOTIFICATION_NOT_FOUND', `Notification ${id} was not found`);
  }
  return respond.ok(res, result.rows[0], { requestId: req.id });
}));

app.patch('/api/notifications/:id/status', asyncHandler(async (req, res) => {
  const id = validate.intField(req.params.id, 'id');
  const status = validate.enumField(
    String(validate.stringField(req.body.status, 'status', { max: 20 })).toUpperCase(),
    'status',
    ['PENDING', 'SENT', 'FAILED']
  );
  const result = await pool.query(
    `UPDATE notifications SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, member_id, book_id, type, message, status, created_at, updated_at`,
    [id, status]
  );
  if (result.rows.length === 0) {
    return respond.fail(res, 404, 'NOTIFICATION_NOT_FOUND', `Notification ${id} was not found`);
  }
  stats.inc('status_updates');
  return respond.ok(res, result.rows[0], { requestId: req.id });
}));

app.use(errors.notFoundHandler);
app.use(errors.errorHandler(log));

const agent = new meshAgent.MeshAgent({
  controlPlaneUrl: config.readEnv('CONTROL_PLANE_URL'),
  serviceToken: config.readEnv('CONTROL_PLANE_SERVICE_TOKEN'),
  component: {
    id: COMPONENT,
    name: 'Notification Service - AWS',
    kind: 'service',
    cloud: 'aws',
    role: 'notification',
    baseUrl: config.optionalEnv('NOTIFICATION_SERVICE_BASE_URL', `http://notification-service:${PORT}`),
    meta: { port: PORT, database: 'render_library' }
  },
  getStatus: () => (dbHealthy ? 'healthy' : 'unhealthy'),
  getMetrics: () => stats.snapshot(),
  getMeta: () => ({ database: { connected: dbHealthy, lastCheck: lastDbCheck } })
});

const server = app.listen(PORT, '0.0.0.0', () => {
  log.info('listening', { port: PORT, cloud: 'aws' });
  agent.start();
  void checkDatabase();
});

const dbTimer = setInterval(() => {
  void checkDatabase();
}, 5000);
dbTimer.unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown_started', { signal });
  clearInterval(dbTimer);
  server.close();
  await agent.stop();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled_rejection', { message: reason instanceof Error ? reason.message : String(reason) });
});
