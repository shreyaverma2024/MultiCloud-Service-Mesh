'use strict';

const express = require('express');
const {
  config,
  logger,
  respond,
  errors,
  metrics,
  circuitBreaker,
  meshAgent,
  hmac,
  http,
  requestId,
  securityHeaders,
  asyncHandler
} = require('@mesh/shared');

const COMPONENT = 'api-gateway';
const log = logger.child(COMPONENT);

config.requireSecrets(
  ['CONTROL_PLANE_SERVICE_TOKEN', 'AWS_TO_RENDER_HMAC_SECRET', 'RENDER_TO_AWS_HMAC_SECRET'],
  COMPONENT
);
config.requireEnv(
  ['CONTROL_PLANE_URL', 'CONTROL_PLANE_SERVICE_TOKEN', 'AWS_TO_RENDER_HMAC_SECRET', 'RENDER_TO_AWS_HMAC_SECRET'],
  COMPONENT
);

const PORT = config.intEnv('GATEWAY_PORT', 8080, 1, 65535);
const CP_URL = config.readEnv('CONTROL_PLANE_URL').replace(/\/+$/, '');
const CP_TOKEN = config.readEnv('CONTROL_PLANE_SERVICE_TOKEN');
const AWS_TO_RENDER = config.readEnv('AWS_TO_RENDER_HMAC_SECRET');
const RENDER_TO_AWS = config.readEnv('RENDER_TO_AWS_HMAC_SECRET');
const TIMEOUT_MS = config.intEnv('GATEWAY_TIMEOUT_MS', 2500, 200, 30000);
const RETRIES = config.intEnv('GATEWAY_RETRIES', 1, 0, 3);
const BREAKER_CONFIG = {
  failureThreshold: config.intEnv('GATEWAY_BREAKER_FAILURES', 5, 1, 100),
  successThreshold: config.intEnv('GATEWAY_BREAKER_SUCCESSES', 2, 1, 20),
  cooldownMs: config.intEnv('GATEWAY_BREAKER_COOLDOWN_MS', 10000, 1000, 300000),
  halfOpenMaxCalls: 1
};

const FALLBACKS = {
  'book-primary-sidecar': config.optionalEnv('BOOK_PRIMARY_URL', 'http://book-primary-sidecar:5101'),
  'book-replica-sidecar': config.optionalEnv('BOOK_REPLICA_URL', 'http://book-replica-sidecar:5104'),
  'borrow-sidecar': config.optionalEnv('BORROW_SIDECAR_URL', 'http://borrow-sidecar:5102'),
  'notification-sidecar': config.optionalEnv('NOTIFICATION_SIDECAR_URL', 'http://notification-sidecar:5103'),
  'member-sidecar': config.optionalEnv('MEMBER_SIDECAR_URL', 'http://member-sidecar:5105')
};

const stats = new metrics.Metrics(COMPONENT);
const targetMetrics = new Map();
const breakers = new Map();
const nonceStore = new hmac.NonceStore();

let routing = { version: 0, policy: { aws: 70, render: 30 }, targets: [] };
let routingLoaded = false;
let registry = new Map();
let registryLoaded = false;
let lastRefreshSuccessAt = 0;
let lastRefreshError = null;
let refreshBusy = false;
let observed = { aws: 0, render: 0 };
let failovers = 0;
let retryCount = 0;

function targetStats(id) {
  if (!targetMetrics.has(id)) targetMetrics.set(id, new metrics.Metrics(`gateway->${id}`));
  return targetMetrics.get(id);
}

function getBreaker(id) {
  if (!breakers.has(id)) {
    breakers.set(
      id,
      new circuitBreaker.CircuitBreaker({
        name: `gateway->${id}`,
        ...BREAKER_CONFIG,
        onTransition: (event) => {
          stats.inc('breaker_transitions');
          log.warn('circuit_breaker_transition', event);
          agent.reportEvent({
            severity: event.to === 'OPEN' ? 'warn' : 'info',
            type: 'circuit_breaker_transition',
            message: `API Gateway circuit breaker for ${id} changed from ${event.from} to ${event.to}`,
            details: { target: id, ...event }
          });
        }
      })
    );
  }
  return breakers.get(id);
}

function cpReachable() {
  return lastRefreshSuccessAt > 0 && Date.now() - lastRefreshSuccessAt < 10000;
}

async function refreshRouting() {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    const routingResult = await http.requestJson(`${CP_URL}/api/routing`, {
      headers: { 'x-service-token': CP_TOKEN },
      timeoutMs: 2000,
      retries: 0
    });
    if (routingResult.ok && routingResult.json && routingResult.json.data) {
      const data = routingResult.json.data;
      if (data.policy && Array.isArray(data.targets)) {
        routing = {
          version: data.version,
          policy: { aws: Number(data.policy.aws), render: Number(data.policy.render) },
          updatedAt: data.updatedAt,
          updatedBy: data.updatedBy,
          targets: data.targets
        };
        routingLoaded = true;
        for (const target of routing.targets) getBreaker(target.id);
      }
    } else {
      lastRefreshError = `routing_http_${routingResult.status}`;
    }

    const registryResult = await http.requestJson(`${CP_URL}/api/registry/services`, {
      headers: { 'x-service-token': CP_TOKEN },
      timeoutMs: 2000,
      retries: 0
    });
    if (registryResult.ok && registryResult.json && Array.isArray(registryResult.json.data)) {
      registry = new Map(registryResult.json.data.map((record) => [record.id, record]));
      registryLoaded = true;
    } else {
      lastRefreshError = `registry_http_${registryResult.status}`;
    }

    if (routingResult.ok && registryResult.ok) {
      lastRefreshSuccessAt = Date.now();
      lastRefreshError = null;
    }
  } catch (error) {
    lastRefreshError = error.message;
  } finally {
    refreshBusy = false;
  }
}

function namedTarget(name, cloud) {
  const record = registry.get(name);
  if (record) {
    return {
      id: name,
      cloud: record.cloud || cloud,
      baseUrl: record.baseUrl,
      status: record.status,
      weight: 100
    };
  }
  if (!registryLoaded && FALLBACKS[name]) {
    return { id: name, cloud, baseUrl: FALLBACKS[name], status: 'degraded', weight: 100 };
  }
  return null;
}

function bookTargets() {
  if (!routingLoaded) return [];
  return routing.targets.map((target) => ({
    id: target.id,
    cloud: target.cloud,
    baseUrl: target.baseUrl,
    status: target.status,
    routable: target.routable,
    weight: target.weight
  }));
}

function authoritativeTargets(targets) {
  // Authoritative routes must ignore the public weighted policy. The AWS book
  // target can have weight 0 while all public traffic is routed to Render, but
  // cross-cloud reads and writes still have to reach AWS.
  return targets.map((target) => ({ ...target, weight: 100 }));
}

function pickWeighted(candidates, allowZero = false) {
  const filtered = allowZero ? candidates : candidates.filter((item) => item.weight > 0);
  if (filtered.length === 0) return null;
  const positive = filtered.filter((item) => item.weight > 0);
  const pool = positive.length > 0 ? positive : filtered;
  const total = pool.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return pool[Math.floor(Math.random() * pool.length)];
  let value = Math.random() * total;
  for (const item of pool) {
    value -= item.weight;
    if (value < 0) return item;
  }
  return pool[pool.length - 1];
}

function filterRequestHeaders(req) {
  const hopByHop = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
    'content-length',
    'x-admin-token',
    'x-service-token',
    'x-read-token',
    'authorization'
  ]);
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (hopByHop.has(lower)) continue;
    headers[lower] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

function filterResponseHeaders(headers) {
  const hopByHop = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'content-length',
    'content-encoding'
  ]);
  const output = {};
  for (const [name, value] of headers.entries()) {
    if (hopByHop.has(name.toLowerCase())) continue;
    output[name.toLowerCase()] = value;
  }
  return output;
}

async function forward(target, req, path, body) {
  const url = new URL(`${target.baseUrl.replace(/\/+$/, '')}${path}`);
  const headers = filterRequestHeaders(req);
  headers['x-request-id'] = req.id;
  headers['x-mesh-client'] = 'api-gateway';
  headers['x-mesh-target'] = target.id;
  headers['x-mesh-cloud'] = target.cloud;
  headers['x-forwarded-for'] = req.ip || req.socket.remoteAddress || 'unknown';

  if (target.cloud === 'render') {
    const signed = hmac.sign({
      secret: AWS_TO_RENDER,
      client: 'api-gateway',
      method: req.method,
      path: url.pathname + url.search,
      body
    });
    Object.assign(headers, signed);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(url.toString(), {
      method: req.method,
      headers,
      body: body && body.length > 0 ? body : undefined,
      signal: controller.signal,
      redirect: 'manual'
    });
    const arrayBuffer = await response.arrayBuffer();
    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      body: Buffer.from(arrayBuffer),
      durationMs: Date.now() - startedAt,
      target,
      url: url.toString()
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      timedOut: error.name === 'AbortError',
      error: error.name === 'AbortError' ? 'timeout' : error.message,
      durationMs: Date.now() - startedAt,
      target,
      url: url.toString()
    };
  } finally {
    clearTimeout(timer);
  }
}

function sendProxyResponse(res, result, attempts, routeName) {
  const headers = filterResponseHeaders(result.headers);
  headers['x-mesh-route'] = routeName;
  headers['x-mesh-target'] = result.target.id;
  headers['x-mesh-cloud'] = result.target.cloud;
  headers['x-mesh-config-version'] = String(routing.version || 0);
  headers['x-mesh-attempts'] = String(attempts);
  if (attempts > 1) headers['x-mesh-failover'] = 'true';
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  return res.status(result.status).send(result.body);
}

async function proxy(req, res, { routeName, targets, path, verifyCrossCloud = false }) {
  const startedAt = process.hrtime.bigint();

  if (verifyCrossCloud) {
    const verification = hmac.verifyExpressRequest(req, {
      secret: RENDER_TO_AWS,
      client: 'book-replica-service',
      nonceStore,
      maxSkewMs: config.intEnv('HMAC_MAX_SKEW_MS', 300000, 1000, 3600000)
    });
    if (!verification.ok) {
      stats.inc('auth_failures');
      agent.reportEvent({
        severity: 'warn',
        type: 'auth_failure',
        message: 'API Gateway rejected an unsigned cross-cloud request',
        details: { reason: verification.reason, path: req.originalUrl }
      });
      stats.recordRequest(401, Number(process.hrtime.bigint() - startedAt) / 1e6);
      return respond.fail(res, 401, 'HMAC_AUTH_FAILED', 'Cross-cloud request signature is missing or invalid');
    }
  }

  const candidates = targets.filter(
    (target) => target && target.baseUrl && ['healthy', 'degraded'].includes(target.status)
  );

  if (candidates.length === 0) {
    stats.recordRequest(503, Number(process.hrtime.bigint() - startedAt) / 1e6);
    stats.inc('no_healthy_target');
    return respond.fail(res, 503, 'NO_HEALTHY_TARGET', `No healthy endpoint is available for ${routeName}`, {
      routing: {
        version: routing.version,
        configured: routing.policy,
        targets: targets.map((target) => ({
          id: target.id,
          status: target.status,
          baseUrl: target.baseUrl,
          weight: target.weight
        }))
      }
    });
  }

  const usable = candidates.filter((target) => getBreaker(target.id).isAvailable());
  if (usable.length === 0) {
    stats.recordRequest(503, Number(process.hrtime.bigint() - startedAt) / 1e6);
    stats.inc('breaker_rejections');
    return respond.fail(res, 503, 'CIRCUIT_OPEN', `All circuit breakers for ${routeName} are open`, {
      breakers: candidates.map((target) => getBreaker(target.id).snapshot())
    });
  }

  const idempotent = ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
  const maxAttempts = idempotent ? 1 + RETRIES : 1;
  const tried = new Set();
  let attempts = 0;
  let lastResult = null;

  while (attempts < maxAttempts) {
    const remaining = usable.filter((target) => !tried.has(target.id));
    if (remaining.length === 0) break;
    const target = pickWeighted(remaining, attempts > 0);
    if (!target) break;
    // Reserve a half-open probe slot only for the target we actually use.
    if (!getBreaker(target.id).canRequest()) {
      tried.add(target.id);
      continue;
    }
    tried.add(target.id);
    attempts += 1;
    if (attempts > 1) retryCount += 1;

    const result = await forward(target, req, path, req.body);
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    targetStats(target.id).recordRequest(result.ok ? result.status : 0, result.durationMs);
    observed[target.cloud] = (observed[target.cloud] || 0) + 1;

    const breaker = getBreaker(target.id);
    const retryable = !result.ok || result.status >= 500;

    if (retryable) {
      breaker.onFailure();
      stats.inc('upstream_errors');
      if (result.timedOut) stats.inc('timeouts');
      lastResult = result;
      if (attempts < maxAttempts && usable.some((item) => !tried.has(item.id))) {
        failovers += 1;
        stats.inc('failovers');
        log.warn('target_failed_failing_over', {
          requestId: req.id,
          route: routeName,
          target: target.id,
          status: result.status,
          error: result.error,
          attempt: attempts
        });
        continue;
      }
    } else {
      breaker.onSuccess();
    }

    stats.recordRequest(result.ok ? result.status : result.timedOut ? 504 : 502, durationMs);
    if (result.ok) {
      return sendProxyResponse(res, result, attempts, routeName);
    }
    res.setHeader('x-mesh-route', routeName);
    res.setHeader('x-mesh-target', target.id);
    res.setHeader('x-mesh-cloud', target.cloud);
    res.setHeader('x-mesh-attempts', String(attempts));
    // Report the failover even when the alternate target also failed. The
    // response still reflects the last attempt, but operators must be able to
    // see that the gateway retried against another target.
    if (attempts > 1) res.setHeader('x-mesh-failover', 'true');
    return respond.fail(
      res,
      result.timedOut ? 504 : 502,
      result.timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
      result.timedOut ? `${target.id} timed out` : `${target.id} is unavailable`,
      { target: target.id, error: result.error, attempts }
    );
  }

  stats.recordRequest(503, Number(process.hrtime.bigint() - startedAt) / 1e6);
  res.setHeader('x-mesh-route', routeName);
  res.setHeader('x-mesh-attempts', String(attempts));
  if (lastResult && lastResult.target) {
    res.setHeader('x-mesh-target', lastResult.target.id);
    res.setHeader('x-mesh-cloud', lastResult.target.cloud);
  }
  if (attempts > 1) res.setHeader('x-mesh-failover', 'true');
  if (lastResult && lastResult.status) {
    return respond.fail(
      res,
      503,
      'ALL_TARGETS_FAILED',
      `All attempts for ${routeName} failed`,
      { lastStatus: lastResult.status, attempts }
    );
  }
  return respond.fail(res, 503, 'NO_HEALTHY_TARGET', `No healthy endpoint is available for ${routeName}`, {
    attempts
  });
}

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(requestId);
app.use(express.raw({ type: '*/*', limit: '2mb' }));

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    log.info('gateway_request', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100
    });
  });
  next();
});

app.get('/', (req, res) => {
  return respond.ok(res, {
    component: COMPONENT,
    cloud: 'aws',
    routes: ['/api/books', '/api/borrows', '/api/notifications', '/api/members', '/cross-cloud/books'],
    health: '/health',
    metrics: '/metrics'
  });
});

app.get('/health', (req, res) => {
  const routableBooks = routingLoaded ? routing.targets.filter((target) => target.routable) : [];
  const status = cpReachable()
    ? routableBooks.length > 0
      ? 'healthy'
      : 'degraded'
    : routingLoaded
      ? 'degraded'
      : 'unhealthy';
  return respond.ok(res, {
    component: COMPONENT,
    status,
    cloud: 'aws',
    controlPlane: {
      url: CP_URL,
      reachable: cpReachable(),
      lastSuccessAt: lastRefreshSuccessAt ? new Date(lastRefreshSuccessAt).toISOString() : null,
      lastError: lastRefreshError
    },
    routing: {
      version: routing.version,
      loaded: routingLoaded,
      configured: routing.policy,
      routableTargets: routableBooks.length
    }
  });
});

app.get('/metrics', (req, res) => {
  return respond.ok(res, {
    ...stats.snapshot(),
    routing: {
      version: routing.version,
      loaded: routingLoaded,
      configured: routing.policy,
      observed,
      failovers,
      retries: retryCount,
      targets: routing.targets.map((target) => ({
        id: target.id,
        cloud: target.cloud,
        status: target.status,
        routable: target.routable,
        weight: target.weight,
        baseUrl: target.baseUrl,
        metrics: targetStats(target.id).snapshot(),
        breaker: getBreaker(target.id).snapshot()
      }))
    },
    breakers: [...breakers.entries()].map(([id, breaker]) => ({ target: id, ...breaker.snapshot() })),
    controlPlane: { reachable: cpReachable(), lastError: lastRefreshError }
  });
});

app.use('/api/books', asyncHandler(async (req, res) => {
  const targets = bookTargets();
  if (req.method === 'GET' || req.method === 'HEAD') {
    return proxy(req, res, { routeName: 'books-weighted', targets, path: req.originalUrl });
  }
  // Book data is authoritative on AWS. Non-read methods never go to the replica.
  const authoritative = targets.filter((target) => target.id === 'book-primary-sidecar');
  return proxy(req, res, {
    routeName: 'books-authoritative',
    targets: authoritativeTargets(authoritative),
    path: req.originalUrl
  });
}));

app.use('/cross-cloud/books', asyncHandler(async (req, res) => {
  const targets = authoritativeTargets(
    bookTargets().filter((target) => target.id === 'book-primary-sidecar')
  );
  const rewritten = req.originalUrl.replace(/^\/cross-cloud\/books/, '/api/books');
  return proxy(req, res, {
    routeName: 'cross-cloud-books',
    targets,
    path: rewritten,
    verifyCrossCloud: true
  });
}));

app.use('/api/borrows', asyncHandler(async (req, res) => {
  const target = namedTarget('borrow-sidecar', 'aws');
  return proxy(req, res, {
    routeName: 'borrows',
    targets: target ? [target] : [],
    path: req.originalUrl
  });
}));

app.use('/api/notifications', asyncHandler(async (req, res) => {
  const target = namedTarget('notification-sidecar', 'aws');
  return proxy(req, res, {
    routeName: 'notifications',
    targets: target ? [target] : [],
    path: req.originalUrl
  });
}));

app.use('/api/members', asyncHandler(async (req, res) => {
  const target = namedTarget('member-sidecar', 'render');
  return proxy(req, res, {
    routeName: 'members',
    targets: target ? [target] : [],
    path: req.originalUrl
  });
}));

app.use(errors.notFoundHandler);
app.use(errors.errorHandler(log));

const agent = new meshAgent.MeshAgent({
  controlPlaneUrl: CP_URL,
  serviceToken: CP_TOKEN,
  component: {
    id: COMPONENT,
    name: 'API Gateway - AWS',
    kind: 'gateway',
    cloud: 'aws',
    role: 'gateway',
    baseUrl: config.optionalEnv('API_GATEWAY_BASE_URL', `http://api-gateway:${PORT}`),
    meta: {
      port: PORT,
      clientEntryPoint: true,
      weightedBookRouting: true,
      initialWeights: { aws: 70, render: 30 }
    }
  },
  getStatus: () => {
    if (!cpReachable() && !routingLoaded) return 'unhealthy';
    const routableBooks = routing.targets.filter((target) => target.routable);
    if (routableBooks.length === 0) return 'degraded';
    return cpReachable() ? 'healthy' : 'degraded';
  },
  getMetrics: () => stats.snapshot(),
  getMeta: () => ({
    controlPlane: {
      reachable: cpReachable(),
      lastSuccessAt: lastRefreshSuccessAt ? new Date(lastRefreshSuccessAt).toISOString() : null,
      lastError: lastRefreshError
    },
    routing: {
      version: routing.version,
      loaded: routingLoaded,
      configured: routing.policy,
      observed,
      failovers,
      retries: retryCount,
      targets: routing.targets.map((target) => ({
        id: target.id,
        cloud: target.cloud,
        status: target.status,
        routable: target.routable,
        weight: target.weight,
        baseUrl: target.baseUrl,
        metrics: targetStats(target.id).snapshot(),
        breaker: getBreaker(target.id).snapshot()
      })),
      breakers: [...breakers.entries()].map(([id, breaker]) => ({ target: id, ...breaker.snapshot() }))
    }
  })
});

const server = app.listen(PORT, '0.0.0.0', () => {
  log.info('listening', { port: PORT, cloud: 'aws' });
  agent.start();
  void refreshRouting();
});

const refreshTimer = setInterval(() => {
  void refreshRouting();
}, 2000);
refreshTimer.unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown_started', { signal });
  clearInterval(refreshTimer);
  server.close();
  await agent.stop();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled_rejection', { message: reason instanceof Error ? reason.message : String(reason) });
});
