'use strict';

const crypto = require('node:crypto');
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

const COMPONENT = 'book-service';
const log = logger.child(COMPONENT);

config.requireSecrets(
  ['AWS_DB_PASSWORD', 'CACHE_API_KEY', 'CONTROL_PLANE_SERVICE_TOKEN'],
  COMPONENT
);
config.requireEnv(
  ['AWS_DB_NAME', 'AWS_DB_USER', 'POSTGRES_HOST', 'CACHE_API_URL', 'CONTROL_PLANE_URL'],
  COMPONENT
);

const PORT = config.intEnv('BOOK_SERVICE_PORT', 4101, 1, 65535);
const CACHE_TTL = config.intEnv('BOOK_CACHE_TTL_SECONDS', 60, 1, 3600);

const pool = db.createPool('AWS', COMPONENT);
const cache = new cacheClient.CacheClient({
  url: config.readEnv('CACHE_API_URL'),
  apiKey: config.readEnv('CACHE_API_KEY'),
  timeoutMs: config.intEnv('CACHE_API_TIMEOUT_MS', 1500, 200, 10000)
});

const stats = new metrics.Metrics(COMPONENT);
let dbHealthy = false;
let cacheHealthy = false;
let lastDbCheck = null;
let lastCacheCheck = null;

function cacheKey(...parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

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

const BOOK_COLUMNS = `
  id, title, author, isbn, category, total_copies, available_copies,
  published_year, created_at
`;

async function findBookById(id) {
  const result = await pool.query(`SELECT ${BOOK_COLUMNS} FROM books WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function cachedBook(id) {
  const key = cacheKey('book', id);
  const cached = await cache.get('books', key);
  if (cached.available && cached.hit) {
    stats.inc('cache_hits');
    return { book: cached.value, cache: 'hit' };
  }
  if (!cached.available) {
    cache.noteFallback();
    stats.inc('cache_fallbacks');
  } else {
    stats.inc('cache_misses');
  }
  const book = await findBookById(id);
  if (book) {
    const stored = await cache.set('books', key, book, CACHE_TTL);
    if (!stored.available) {
      cache.noteFallback();
      stats.inc('cache_fallbacks');
    }
  }
  return { book, cache: cached.available ? 'miss' : 'fallback' };
}

async function cachedQuery(keyParts, ttl, loader) {
  const key = cacheKey(...keyParts);
  const cached = await cache.get('books', key);
  if (cached.available && cached.hit) {
    stats.inc('cache_hits');
    return { value: cached.value, cache: 'hit' };
  }
  if (!cached.available) {
    cache.noteFallback();
    stats.inc('cache_fallbacks');
  } else {
    stats.inc('cache_misses');
  }
  const value = await loader();
  const stored = await cache.set('books', key, value, ttl);
  if (!stored.available) {
    cache.noteFallback();
    stats.inc('cache_fallbacks');
  }
  return { value, cache: cached.available ? 'miss' : 'fallback' };
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
  const status = dbHealthy ? (cacheHealthy ? 'healthy' : 'degraded') : 'unhealthy';
  return respond.ok(res, {
    component: COMPONENT,
    status,
    cloud: 'aws',
    database: { connected: dbHealthy, lastCheck: lastDbCheck },
    cache: { available: cacheHealthy, lastCheck: lastCacheCheck },
    uptimeSeconds: stats.snapshot().uptimeSeconds
  });
}));

app.get('/ready', (req, res) => {
  if (!dbHealthy) {
    return respond.fail(res, 503, 'NOT_READY', 'Authoritative database is unavailable');
  }
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

app.get('/api/books', asyncHandler(async (req, res) => {
  const limit = validate.intQuery(req.query.limit, 'limit', { fallback: 20, min: 1, max: 100 });
  const offset = validate.intQuery(req.query.offset, 'offset', { fallback: 0, min: 0, max: 100000 });
  const category = req.query.category ? validate.stringField(req.query.category, 'category', { max: 80 }) : null;
  const search = req.query.search ? validate.stringField(req.query.search, 'search', { max: 120 }) : null;

  const result = await cachedQuery(
    ['list', limit, offset, category || '', search || ''],
    30,
    async () => {
      const values = [];
      const conditions = [];
      if (category) {
        values.push(category);
        conditions.push(`category = $${values.length}`);
      }
      if (search) {
        values.push(`%${search}%`);
        conditions.push(`(title ILIKE $${values.length} OR author ILIKE $${values.length} OR isbn ILIKE $${values.length})`);
      }
      values.push(limit, offset);
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const query = `
        SELECT ${BOOK_COLUMNS}
        FROM books
        ${where}
        ORDER BY id
        LIMIT $${values.length - 1} OFFSET $${values.length}
      `;
      const rows = await pool.query(query, values);
      stats.inc('db_queries');
      return rows.rows;
    }
  );

  return respond.ok(res, result.value, {
    cache: result.cache,
    limit,
    offset,
    count: result.value.length,
    requestId: req.id
  });
}));

app.get('/api/books/search', asyncHandler(async (req, res) => {
  const q = validate.stringField(req.query.q, 'q', { min: 1, max: 120 });
  const limit = validate.intQuery(req.query.limit, 'limit', { fallback: 20, min: 1, max: 100 });

  const result = await cachedQuery(['search', q, limit], 30, async () => {
    const rows = await pool.query(
      `SELECT ${BOOK_COLUMNS}
       FROM books
       WHERE title ILIKE $1 OR author ILIKE $1 OR isbn ILIKE $1 OR category ILIKE $1
       ORDER BY title
       LIMIT $2`,
      [`%${q}%`, limit]
    );
    stats.inc('db_queries');
    return rows.rows;
  });

  return respond.ok(res, result.value, {
    cache: result.cache,
    query: q,
    count: result.value.length,
    requestId: req.id
  });
}));

app.get('/api/books/:id', asyncHandler(async (req, res) => {
  const id = validate.intField(req.params.id, 'id');
  const result = await cachedBook(id);
  if (!result.book) {
    stats.inc('not_found');
    return respond.fail(res, 404, 'BOOK_NOT_FOUND', `Book ${id} was not found`);
  }
  return respond.ok(res, result.book, {
    cache: result.cache,
    source: result.cache === 'hit' ? 'cache' : 'database',
    requestId: req.id
  });
}));

app.get('/api/books/:id/availability', asyncHandler(async (req, res) => {
  const id = validate.intField(req.params.id, 'id');
  const result = await cachedBook(id);
  if (!result.book) {
    return respond.fail(res, 404, 'BOOK_NOT_FOUND', `Book ${id} was not found`);
  }
  return respond.ok(
    res,
    {
      bookId: result.book.id,
      availableCopies: result.book.available_copies,
      totalCopies: result.book.total_copies,
      available: result.book.available_copies > 0
    },
    { cache: result.cache, requestId: req.id }
  );
}));

app.use(errors.notFoundHandler);
app.use(errors.errorHandler(log));

const agent = new meshAgent.MeshAgent({
  controlPlaneUrl: config.readEnv('CONTROL_PLANE_URL'),
  serviceToken: config.readEnv('CONTROL_PLANE_SERVICE_TOKEN'),
  component: {
    id: COMPONENT,
    name: 'Book Service - AWS Primary',
    kind: 'service',
    cloud: 'aws',
    role: 'book-primary',
    baseUrl: config.optionalEnv('BOOK_SERVICE_BASE_URL', `http://book-service:${PORT}`),
    meta: { port: PORT, database: 'aws_library', readOnly: false }
  },
  getStatus: () => (dbHealthy ? (cacheHealthy ? 'healthy' : 'degraded') : 'unhealthy'),
  getMetrics: () => stats.snapshot(),
  getMeta: () => ({
    cache: { available: cacheHealthy, lastCheck: lastCacheCheck },
    database: { connected: dbHealthy, lastCheck: lastDbCheck }
  })
});

const server = app.listen(PORT, '0.0.0.0', () => {
  log.info('listening', { port: PORT, cloud: 'aws' });
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
