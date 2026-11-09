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
  hmac,
  http,
  requestId,
  securityHeaders,
  asyncHandler
} = require('@mesh/shared');

const COMPONENT = 'borrow-service';
const log = logger.child(COMPONENT);

config.requireSecrets(
  ['AWS_DB_PASSWORD', 'CACHE_API_KEY', 'CONTROL_PLANE_SERVICE_TOKEN', 'AWS_TO_RENDER_HMAC_SECRET'],
  COMPONENT
);
config.requireEnv(
  ['AWS_DB_NAME', 'AWS_DB_USER', 'POSTGRES_HOST', 'BOOK_SIDECAR_URL', 'NOTIFICATION_SIDECAR_URL', 'CACHE_API_URL', 'CONTROL_PLANE_URL'],
  COMPONENT
);

const PORT = config.intEnv('BORROW_SERVICE_PORT', 4102, 1, 65535);
const BOOK_SIDECAR_URL = config.readEnv('BOOK_SIDECAR_URL').replace(/\/+$/, '');
const NOTIFICATION_SIDECAR_URL = config.readEnv('NOTIFICATION_SIDECAR_URL').replace(/\/+$/, '');
const CACHE_API_URL = config.readEnv('CACHE_API_URL').replace(/\/+$/, '');
const CACHE_API_KEY = config.readEnv('CACHE_API_KEY');
const CP_URL = config.readEnv('CONTROL_PLANE_URL').replace(/\/+$/, '');
const CP_SERVICE_TOKEN = config.readEnv('CONTROL_PLANE_SERVICE_TOKEN');
const HMAC_SECRET = config.readEnv('AWS_TO_RENDER_HMAC_SECRET');
const MEMBER_FALLBACK_URL = config.optionalEnv('MEMBER_SIDECAR_URL', '').replace(/\/+$/, '');

const pool = db.createPool('AWS', COMPONENT);
const cache = new cacheClient.CacheClient({ url: CACHE_API_URL, apiKey: CACHE_API_KEY });
const stats = new metrics.Metrics(COMPONENT);

let dbHealthy = false;
let bookSidecarHealthy = false;
let lastDbCheck = null;
let lastBookCheck = null;
let memberSidecarUrl = MEMBER_FALLBACK_URL || null;
let memberDiscoveryAt = 0;
let memberDiscoveryError = null;

async function checkDependencies() {
  try {
    dbHealthy = await db.ping(pool);
  } catch {
    dbHealthy = false;
  }
  lastDbCheck = new Date().toISOString();

  const bookHealth = await http.requestJson(`${BOOK_SIDECAR_URL}/health`, {
    timeoutMs: 1500,
    retries: 0
  });
  bookSidecarHealthy =
    bookHealth.ok && bookHealth.json && bookHealth.json.data && bookHealth.json.data.status === 'healthy';
  lastBookCheck = new Date().toISOString();
}

async function discoverMemberSidecar() {
  const now = Date.now();
  if (now - memberDiscoveryAt < 5000) return memberSidecarUrl;
  memberDiscoveryAt = now;
  try {
    const result = await http.requestJson(
      `${CP_URL}/api/registry/services?name=member-sidecar`,
      {
        headers: { 'x-service-token': CP_SERVICE_TOKEN },
        timeoutMs: 2000,
        retries: 0
      }
    );
    if (result.ok && result.json && Array.isArray(result.json.data)) {
      const record = result.json.data.find((item) => item.name === 'member-sidecar');
      if (record && record.baseUrl) {
        memberSidecarUrl = record.baseUrl.replace(/\/+$/, '');
        memberDiscoveryError = null;
        return memberSidecarUrl;
      }
      memberDiscoveryError = 'member_sidecar_not_registered';
    } else {
      memberDiscoveryError = `discovery_http_${result.status}`;
    }
  } catch (error) {
    memberDiscoveryError = error.message;
  }
  return memberSidecarUrl;
}

async function fetchMember(memberId) {
  const baseUrl = await discoverMemberSidecar();
  if (!baseUrl) {
    stats.inc('member_lookup_failures');
    throw new errors.ApiError(503, 'MEMBER_SERVICE_UNAVAILABLE', 'Member Service is not discoverable');
  }
  const url = new URL(`${baseUrl}/api/members/${memberId}`);
  const result = await http.requestJson(url.toString(), {
    buildHeaders: () =>
      hmac.sign({
        secret: HMAC_SECRET,
        client: 'borrow-service',
        method: 'GET',
        path: url.pathname + url.search
      }),
    timeoutMs: config.intEnv('MEMBER_LOOKUP_TIMEOUT_MS', 4000, 500, 15000),
    retries: 1,
    retryDelayMs: 150
  });
  stats.inc('member_lookups');
  if (result.status === 404) {
    throw new errors.ApiError(404, 'MEMBER_NOT_FOUND', `Member ${memberId} was not found`);
  }
  if (!result.ok || !result.json || !result.json.data) {
    stats.inc('member_lookup_failures');
    throw new errors.ApiError(
      503,
      'MEMBER_SERVICE_UNAVAILABLE',
      'Member Service could not be reached for validation',
      { status: result.status, error: result.error || undefined }
    );
  }
  if (result.json.data.active === false) {
    throw new errors.ApiError(409, 'MEMBER_INACTIVE', `Member ${memberId} is inactive`);
  }
  return result.json.data;
}

async function fetchBook(bookId) {
  const result = await http.requestJson(`${BOOK_SIDECAR_URL}/api/books/${bookId}`, {
    timeoutMs: 3000,
    retries: 1,
    retryDelayMs: 150
  });
  if (result.status === 404) {
    throw new errors.ApiError(404, 'BOOK_NOT_FOUND', `Book ${bookId} was not found`);
  }
  if (!result.ok || !result.json || !result.json.data) {
    throw new errors.ApiError(
      503,
      'BOOK_SERVICE_UNAVAILABLE',
      'Book Service could not be reached for validation',
      { status: result.status, error: result.error || undefined }
    );
  }
  return result.json.data;
}

async function invalidateBookCache() {
  const result = await cache.invalidate('books');
  if (!result.available) {
    cache.noteFallback();
    stats.inc('cache_fallbacks');
  }
}

async function createNotification({ memberId, bookId, type, message }) {
  const result = await http.requestJson(`${NOTIFICATION_SIDECAR_URL}/api/notifications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberId, bookId, type, message }),
    timeoutMs: 3000,
    retries: 0
  });
  if (!result.ok) {
    stats.inc('notification_failures');
    log.warn('notification_failed', { status: result.status, type, requestId: null });
    return { delivered: false, status: result.status };
  }
  stats.inc('notifications_sent');
  return { delivered: true, notification: result.json && result.json.data ? result.json.data : null };
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
  const status = dbHealthy ? (bookSidecarHealthy ? 'healthy' : 'degraded') : 'unhealthy';
  return respond.ok(res, {
    component: COMPONENT,
    status,
    cloud: 'aws',
    database: { connected: dbHealthy, lastCheck: lastDbCheck },
    bookSidecar: { healthy: bookSidecarHealthy, lastCheck: lastBookCheck },
    memberService: { discoveredUrl: memberSidecarUrl, error: memberDiscoveryError }
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
    bookSidecarHealthy,
    memberSidecarUrl,
    memberDiscoveryError
  });
});

app.post('/api/borrows', asyncHandler(async (req, res) => {
  const bookId = validate.intField(req.body.bookId, 'bookId');
  const memberId = validate.intField(req.body.memberId, 'memberId');
  const days = validate.intField(req.body.days, 'days', { min: 1, max: 30, required: false }) || 14;

  const member = await fetchMember(memberId);
  const book = await fetchBook(bookId);

  const borrow = await db.withTransaction(pool, async (client) => {
    const locked = await client.query(
      'SELECT id, title, available_copies, total_copies FROM books WHERE id = $1 FOR UPDATE',
      [bookId]
    );
    stats.inc('db_queries');
    if (locked.rows.length === 0) {
      throw new errors.ApiError(404, 'BOOK_NOT_FOUND', `Book ${bookId} was not found`);
    }
    const lockedBook = locked.rows[0];
    if (lockedBook.available_copies <= 0) {
      stats.inc('book_unavailable');
      throw new errors.ApiError(409, 'BOOK_UNAVAILABLE', `Book ${bookId} has no available copies`);
    }
    const inserted = await client.query(
      `INSERT INTO borrows (book_id, member_id, due_at, status)
       VALUES ($1, $2, NOW() + ($3 || ' days')::interval, 'BORROWED')
       RETURNING id, book_id, member_id, borrowed_at, due_at, returned_at, status`,
      [bookId, memberId, String(days)]
    );
    await client.query(
      'UPDATE books SET available_copies = available_copies - 1 WHERE id = $1',
      [bookId]
    );
    return inserted.rows[0];
  });

  stats.inc('borrows_created');
  const notification = await createNotification({
    memberId,
    bookId,
    type: 'BORROW',
    message: `Book "${book.title}" borrowed by ${member.name} until ${borrow.due_at}`
  });
  await invalidateBookCache();

  return respond.ok(
    res,
    { ...borrow, bookTitle: book.title, memberName: member.name, notification: notification.delivered ? 'sent' : 'failed' },
    { requestId: req.id },
    201
  );
}));

app.post('/api/borrows/:id/return', asyncHandler(async (req, res) => {
  const id = validate.intField(req.params.id, 'id');

  const returned = await db.withTransaction(pool, async (client) => {
    const locked = await client.query(
      `SELECT id, book_id, member_id, borrowed_at, due_at, returned_at, status
       FROM borrows WHERE id = $1 FOR UPDATE`,
      [id]
    );
    stats.inc('db_queries');
    if (locked.rows.length === 0) {
      throw new errors.ApiError(404, 'BORROW_NOT_FOUND', `Borrow ${id} was not found`);
    }
    const borrow = locked.rows[0];
    if (borrow.returned_at || borrow.status === 'RETURNED') {
      throw new errors.ApiError(409, 'ALREADY_RETURNED', `Borrow ${id} has already been returned`);
    }
    const updated = await client.query(
      `UPDATE borrows SET returned_at = NOW(), status = 'RETURNED'
       WHERE id = $1
       RETURNING id, book_id, member_id, borrowed_at, due_at, returned_at, status`,
      [id]
    );
    await client.query(
      'UPDATE books SET available_copies = LEAST(total_copies, available_copies + 1) WHERE id = $1',
      [borrow.book_id]
    );
    return updated.rows[0];
  });

  stats.inc('returns');
  const book = await fetchBook(returned.book_id);
  const notification = await createNotification({
    memberId: returned.member_id,
    bookId: returned.book_id,
    type: 'RETURN',
    message: `Book "${book.title}" returned by member ${returned.member_id}`
  });
  await invalidateBookCache();

  return respond.ok(
    res,
    { ...returned, bookTitle: book.title, notification: notification.delivered ? 'sent' : 'failed' },
    { requestId: req.id }
  );
}));

app.get('/api/borrows', asyncHandler(async (req, res) => {
  const limit = validate.intQuery(req.query.limit, 'limit', { fallback: 50, min: 1, max: 200 });
  const memberId = req.query.memberId ? validate.intField(req.query.memberId, 'memberId') : null;
  const bookId = req.query.bookId ? validate.intField(req.query.bookId, 'bookId') : null;
  const status = req.query.status ? validate.stringField(req.query.status, 'status', { max: 20 }) : null;

  const values = [];
  const conditions = [];
  if (memberId) {
    values.push(memberId);
    conditions.push(`b.member_id = $${values.length}`);
  }
  if (bookId) {
    values.push(bookId);
    conditions.push(`b.book_id = $${values.length}`);
  }
  if (status) {
    values.push(status.toUpperCase());
    conditions.push(`b.status = $${values.length}`);
  }
  values.push(limit);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT b.id, b.book_id, b.member_id, b.borrowed_at, b.due_at, b.returned_at, b.status,
            books.title AS book_title
     FROM borrows b
     JOIN books ON books.id = b.book_id
     ${where}
     ORDER BY b.id DESC
     LIMIT $${values.length}`,
    values
  );
  stats.inc('db_queries');
  return respond.ok(res, result.rows, { count: result.rows.length, requestId: req.id });
}));

app.get('/api/borrows/:id', asyncHandler(async (req, res) => {
  const id = validate.intField(req.params.id, 'id');
  const result = await pool.query(
    `SELECT b.id, b.book_id, b.member_id, b.borrowed_at, b.due_at, b.returned_at, b.status,
            books.title AS book_title
     FROM borrows b
     JOIN books ON books.id = b.book_id
     WHERE b.id = $1`,
    [id]
  );
  stats.inc('db_queries');
  if (result.rows.length === 0) {
    return respond.fail(res, 404, 'BORROW_NOT_FOUND', `Borrow ${id} was not found`);
  }
  return respond.ok(res, result.rows[0], { requestId: req.id });
}));

app.use(errors.notFoundHandler);
app.use(errors.errorHandler(log));

const agent = new meshAgent.MeshAgent({
  controlPlaneUrl: CP_URL,
  serviceToken: CP_SERVICE_TOKEN,
  component: {
    id: COMPONENT,
    name: 'Borrow Service - AWS',
    kind: 'service',
    cloud: 'aws',
    role: 'borrow',
    baseUrl: config.optionalEnv('BORROW_SERVICE_BASE_URL', `http://borrow-service:${PORT}`),
    meta: { port: PORT, database: 'aws_library', crossCloudMemberAccess: true }
  },
  getStatus: () => (dbHealthy ? (bookSidecarHealthy ? 'healthy' : 'degraded') : 'unhealthy'),
  getMetrics: () => stats.snapshot(),
  getMeta: () => ({
    database: { connected: dbHealthy, lastCheck: lastDbCheck },
    bookSidecar: { healthy: bookSidecarHealthy },
    memberSidecarUrl,
    memberDiscoveryError
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
