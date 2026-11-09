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
  cacheClient,
  meshAgent,
  requestId,
  securityHeaders,
  asyncHandler
} = require('@mesh/shared');

const COMPONENT = 'member-service';
const log = logger.child(COMPONENT);

config.requireSecrets(['RENDER_DB_PASSWORD', 'CACHE_API_KEY', 'CONTROL_PLANE_SERVICE_TOKEN'], COMPONENT);
config.requireEnv(
  ['RENDER_DB_NAME', 'RENDER_DB_USER', 'POSTGRES_HOST', 'CACHE_API_URL', 'CONTROL_PLANE_URL'],
  COMPONENT
);

const PORT = config.intEnv('MEMBER_SERVICE_PORT', 4105, 1, 65535);
const CACHE_TTL = config.intEnv('MEMBER_CACHE_TTL_SECONDS', 60, 1, 3600);

const pool = db.createPool('RENDER', COMPONENT);
const cache = new cacheClient.CacheClient({
  url: config.readEnv('CACHE_API_URL'),
  apiKey: config.readEnv('CACHE_API_KEY')
});
const stats = new metrics.Metrics(COMPONENT);

let dbHealthy = false;
let cacheHealthy = false;
let lastDbCheck = null;
let lastCacheCheck = null;

async function checkDependencies() {
  try {
    dbHealthy = await db.ping(pool);
  } catch {
    dbHealthy = false;
  }
  lastDbCheck = new Date().toISOString();

  try {
    const health = await cache.health();
    cacheHealthy = health.available && health.redisAvailable;
  } catch {
    cacheHealthy = false;
  }
  lastCacheCheck = new Date().toISOString();
}

const MEMBER_COLUMNS = 'id, name, email, phone, membership_type, joined_at, active';

async function findMember(id) {
  const result = await pool.query(`SELECT ${MEMBER_COLUMNS} FROM members WHERE id = $1`, [id]);
  return result.rows[0] || null;
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
  await checkDependencies();
  return respond.ok(res, {
    component: COMPONENT,
    status: dbHealthy ? (cacheHealthy ? 'healthy' : 'degraded') : 'unhealthy',
    cloud: 'render',
    database: { connected: dbHealthy, databaseName: config.readEnv('RENDER_DB_NAME'), lastCheck: lastDbCheck },
    cache: { available: cacheHealthy, lastCheck: lastCacheCheck }
  });
}));

app.get('/ready', (req, res) => {
  if (!dbHealthy) return respond.fail(res, 503, 'NOT_READY', 'Database is unavailable');
  return respond.ok(res, { ready: true });
});

app.get('/metrics', (req, res) => {
  return respond.ok(res, {
    ...stats.snapshot(),
    cacheClient: cache.snapshot(),
    databaseConnected: dbHealthy,
    cacheAvailable: cacheHealthy
  });
});

app.post('/api/members', asyncHandler(async (req, res) => {
  const name = validate.stringField(req.body.name, 'name', { min: 2, max: 120 });
  const email = validate.emailField(req.body.email);
  const phone = validate.stringField(req.body.phone, 'phone', { min: 5, max: 30, required: false }) || null;
  const membershipType = req.body.membershipType
    ? validate.enumField(String(req.body.membershipType).toUpperCase(), 'membershipType', ['BASIC', 'PREMIUM', 'STUDENT'])
    : 'BASIC';

  try {
    const result = await pool.query(
      `INSERT INTO members (name, email, phone, membership_type)
       VALUES ($1, $2, $3, $4)
       RETURNING ${MEMBER_COLUMNS}`,
      [name, email, phone, membershipType]
    );
    stats.inc('members_created');
    await cache.invalidate('members');
    return respond.ok(res, result.rows[0], { requestId: req.id }, 201);
  } catch (error) {
    if (error.code === '23505') {
      throw new errors.ApiError(409, 'MEMBER_EMAIL_EXISTS', 'A member with that email already exists');
    }
    throw error;
  }
}));

app.get('/api/members', asyncHandler(async (req, res) => {
  const limit = validate.intQuery(req.query.limit, 'limit', { fallback: 50, min: 1, max: 200 });
  const search = req.query.search
    ? validate.stringField(req.query.search, 'search', { max: 120 })
    : null;
  const values = [];
  let where = '';
  if (search) {
    values.push(`%${search}%`);
    where = `WHERE name ILIKE $1 OR email ILIKE $1`;
  }
  values.push(limit);
  const result = await pool.query(
    `SELECT ${MEMBER_COLUMNS}
     FROM members
     ${where}
     ORDER BY id
     LIMIT $${values.length}`,
    values
  );
  stats.inc('db_queries');
  return respond.ok(res, result.rows, { count: result.rows.length, requestId: req.id });
}));

app.get('/api/members/:id', asyncHandler(async (req, res) => {
  const id = validate.intField(req.params.id, 'id');
  const cached = await cache.get('members', `member:${id}`);
  if (cached.available && cached.hit) {
    stats.inc('cache_hits');
    return respond.ok(res, cached.value, { cache: 'hit', requestId: req.id });
  }
  if (!cached.available) {
    cache.noteFallback();
    stats.inc('cache_fallbacks');
  } else {
    stats.inc('cache_misses');
  }

  const member = await findMember(id);
  stats.inc('db_queries');
  if (!member) {
    return respond.fail(res, 404, 'MEMBER_NOT_FOUND', `Member ${id} was not found`);
  }
  const stored = await cache.set('members', `member:${id}`, member, CACHE_TTL);
  if (!stored.available) {
    cache.noteFallback();
    stats.inc('cache_fallbacks');
  }
  return respond.ok(res, member, { cache: cached.available ? 'miss' : 'fallback', requestId: req.id });
}));

app.use(errors.notFoundHandler);
app.use(errors.errorHandler(log));

const agent = new meshAgent.MeshAgent({
  controlPlaneUrl: config.readEnv('CONTROL_PLANE_URL'),
  serviceToken: config.readEnv('CONTROL_PLANE_SERVICE_TOKEN'),
  component: {
    id: COMPONENT,
    name: 'Member Service - Render',
    kind: 'service',
    cloud: 'render',
    role: 'member',
    baseUrl: config.optionalEnv('MEMBER_SERVICE_BASE_URL', `http://member-service:${PORT}`),
    meta: { port: PORT, database: 'render_library', runtime: 'render-container-process' }
  },
  getStatus: () => (dbHealthy ? (cacheHealthy ? 'healthy' : 'degraded') : 'unhealthy'),
  getMetrics: () => stats.snapshot(),
  getMeta: () => ({
    database: { connected: dbHealthy, lastCheck: lastDbCheck },
    cache: { available: cacheHealthy, lastCheck: lastCacheCheck }
  })
});

const server = app.listen(PORT, '0.0.0.0', () => {
  log.info('listening', { port: PORT, cloud: 'render' });
  agent.start();
  void checkDependencies();
});

const dependencyTimer = setInterval(() => {
  void checkDependencies();
}, 5000);
dependencyTimer.unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown_started', { signal });
  clearInterval(dependencyTimer);
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
