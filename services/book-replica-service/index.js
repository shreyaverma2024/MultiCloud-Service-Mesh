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
  cacheClient,
  meshAgent,
  hmac,
  http,
  requestId,
  securityHeaders,
  asyncHandler
} = require('@mesh/shared');

const COMPONENT = 'book-replica-service';
const log = logger.child(COMPONENT);

config.requireSecrets(
  ['CACHE_API_KEY', 'CONTROL_PLANE_SERVICE_TOKEN', 'RENDER_TO_AWS_HMAC_SECRET'],
  COMPONENT
);
config.requireEnv(['AWS_GATEWAY_URL', 'CACHE_API_URL', 'CONTROL_PLANE_URL'], COMPONENT);

const PORT = config.intEnv('BOOK_REPLICA_SERVICE_PORT', 4104, 1, 65535);
const AWS_GATEWAY_URL = config.readEnv('AWS_GATEWAY_URL').replace(/\/+$/, '');
const CACHE_TTL = config.intEnv('BOOK_REPLICA_CACHE_TTL_SECONDS', 30, 1, 600);
const AWS_TIMEOUT_MS = config.intEnv('BOOK_REPLICA_AWS_TIMEOUT_MS', 3000, 500, 15000);

const cache = new cacheClient.CacheClient({
  url: config.readEnv('CACHE_API_URL'),
  apiKey: config.readEnv('CACHE_API_KEY')
});
const stats = new metrics.Metrics(COMPONENT);

let awsReachable = false;
let lastAwsCheck = null;
let lastAwsError = null;

async function checkAwsGateway() {
  const result = await http.requestJson(`${AWS_GATEWAY_URL}/health`, {
    timeoutMs: 2000,
    retries: 0
  });
  awsReachable = Boolean(result.ok && result.json && result.json.data);
  lastAwsCheck = new Date().toISOString();
  lastAwsError = awsReachable ? null : result.error || `http_${result.status}`;
}

function cacheKey(pathWithQuery) {
  return crypto.createHash('sha1').update(pathWithQuery).digest('hex');
}

/**
 * Fetch authoritative book data from AWS through the API Gateway's
 * HMAC-protected /cross-cloud/books route. This is the only write-free
 * communication path used by the Render replica.
 */
async function fetchAuthoritative(pathWithQuery) {
  const url = new URL(`${AWS_GATEWAY_URL}${pathWithQuery}`);
  stats.inc('aws_requests');
  const result = await http.requestJson(url.toString(), {
    buildHeaders: () =>
      hmac.sign({
        secret: config.readEnv('RENDER_TO_AWS_HMAC_SECRET'),
        client: 'book-replica-service',
        method: 'GET',
        path: url.pathname + url.search
      }),
    timeoutMs: AWS_TIMEOUT_MS,
    retries: 1,
    retryDelayMs: 150
  });
  if (result.status === 404) {
    return { status: 404, body: result.json };
  }
  if (!result.ok || !result.json) {
    stats.inc('aws_failures');
    lastAwsError = result.error || `http_${result.status}`;
    return { status: 503, error: lastAwsError };
  }
  awsReachable = true;
  lastAwsCheck = new Date().toISOString();
  lastAwsError = null;
  return { status: 200, body: result.json };
}

async function serveRead(req, res, awsPath) {
  const key = cacheKey(awsPath);
  const cached = await cache.get('replica-books', key);
  if (cached.available && cached.hit) {
    stats.inc('cache_hits');
    return respond.ok(res, cached.value.data, {
      ...(cached.value.meta || {}),
      cache: 'hit',
      source: 'aws-authoritative',
      requestId: req.id
    });
  }
  if (!cached.available) {
    cache.noteFallback();
    stats.inc('cache_fallbacks');
  } else {
    stats.inc('cache_misses');
  }

  const remote = await fetchAuthoritative(awsPath);
  if (remote.status === 404) {
    return respond.fail(res, 404, 'BOOK_NOT_FOUND', 'The authoritative book record was not found');
  }
  if (remote.status !== 200) {
    return respond.fail(
      res,
      503,
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'The AWS authoritative book service is currently unavailable',
      { error: remote.error }
    );
  }

  const stored = await cache.set('replica-books', key, remote.body, CACHE_TTL);
  if (!stored.available) {
    cache.noteFallback();
    stats.inc('cache_fallbacks');
  }

  return respond.ok(res, remote.body.data, {
    ...(remote.body.meta || {}),
    cache: cached.available ? 'miss' : 'fallback',
    source: 'aws-authoritative',
    requestId: req.id
  });
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
  return respond.ok(res, {
    component: COMPONENT,
    status: awsReachable ? 'healthy' : 'degraded',
    cloud: 'render',
    readOnly: true,
    authoritativeSource: {
      url: `${AWS_GATEWAY_URL}/cross-cloud/books`,
      reachable: awsReachable,
      lastCheck: lastAwsCheck,
      error: lastAwsError
    }
  });
}));

app.get('/ready', (req, res) => {
  return respond.ok(res, { ready: true, readOnly: true });
});

app.get('/metrics', (req, res) => {
  return respond.ok(res, {
    ...stats.snapshot(),
    cacheClient: cache.snapshot(),
    awsReachable,
    lastAwsCheck,
    lastAwsError,
    readOnly: true
  });
});

app.get('/api/books', asyncHandler(async (req, res) => {
  const limit = validate.intQuery(req.query.limit, 'limit', { fallback: 20, min: 1, max: 100 });
  const offset = validate.intQuery(req.query.offset, 'offset', { fallback: 0, min: 0, max: 100000 });
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (req.query.category) params.set('category', validate.stringField(req.query.category, 'category', { max: 80 }));
  if (req.query.search) params.set('search', validate.stringField(req.query.search, 'search', { max: 120 }));
  return serveRead(req, res, `/cross-cloud/books?${params.toString()}`);
}));

app.get('/api/books/search', asyncHandler(async (req, res) => {
  const q = validate.stringField(req.query.q, 'q', { min: 1, max: 120 });
  const limit = validate.intQuery(req.query.limit, 'limit', { fallback: 20, min: 1, max: 100 });
  const params = new URLSearchParams({ q, limit: String(limit) });
  return serveRead(req, res, `/cross-cloud/books/search?${params.toString()}`);
}));

app.get('/api/books/:id/availability', asyncHandler(async (req, res) => {
  const id = validate.intField(req.params.id, 'id');
  return serveRead(req, res, `/cross-cloud/books/${id}/availability`);
}));

app.get('/api/books/:id', asyncHandler(async (req, res) => {
  const id = validate.intField(req.params.id, 'id');
  return serveRead(req, res, `/cross-cloud/books/${id}`);
}));

app.all(/^\/api\/books.*/, (req, res) => {
  stats.inc('read_only_rejections');
  return respond.fail(
    res,
    405,
    'READ_ONLY_REPLICA',
    'The Render Book Replica is read-only. Authoritative book records can only be changed on AWS.'
  );
});

app.use(errors.notFoundHandler);
app.use(errors.errorHandler(log));

const agent = new meshAgent.MeshAgent({
  controlPlaneUrl: config.readEnv('CONTROL_PLANE_URL'),
  serviceToken: config.readEnv('CONTROL_PLANE_SERVICE_TOKEN'),
  component: {
    id: COMPONENT,
    name: 'Book Replica Service - Render',
    kind: 'service',
    cloud: 'render',
    role: 'book-replica',
    baseUrl: config.optionalEnv('BOOK_REPLICA_SERVICE_BASE_URL', `http://book-replica-service:${PORT}`),
    meta: {
      port: PORT,
      readOnly: true,
      authoritativeSource: `${AWS_GATEWAY_URL}/cross-cloud/books`,
      runtime: 'render-container-process'
    }
  },
  getStatus: () => (awsReachable ? 'healthy' : 'degraded'),
  getMetrics: () => stats.snapshot(),
  getMeta: () => ({
    readOnly: true,
    awsReachable,
    lastAwsCheck,
    lastAwsError,
    cache: { available: cache.stats.errors === 0 }
  })
});

const server = app.listen(PORT, '0.0.0.0', () => {
  log.info('listening', { port: PORT, cloud: 'render', readOnly: true });
  agent.start();
  void checkAwsGateway();
});

const awsTimer = setInterval(() => {
  void checkAwsGateway();
}, 10000);
awsTimer.unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown_started', { signal });
  clearInterval(awsTimer);
  server.close();
  await agent.stop();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled_rejection', { message: reason instanceof Error ? reason.message : String(reason) });
});
