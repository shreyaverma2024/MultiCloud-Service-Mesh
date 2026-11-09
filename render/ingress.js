'use strict';

const express = require('express');
const {
  config,
  logger,
  respond,
  errors,
  metrics,
  hmac,
  auth,
  meshAgent,
  http,
  requestId,
  securityHeaders,
  asyncHandler
} = require('@mesh/shared');

const COMPONENT = 'render-ingress';
const log = logger.child(COMPONENT);

config.requireSecrets(
  ['CONTROL_PLANE_SERVICE_TOKEN', 'AWS_TO_RENDER_HMAC_SECRET'],
  COMPONENT
);
config.requireEnv(
  ['CONTROL_PLANE_URL', 'CONTROL_PLANE_SERVICE_TOKEN', 'AWS_TO_RENDER_HMAC_SECRET'],
  COMPONENT
);

// Render assigns PORT. We must bind to 0.0.0.0 and use that port.
const PORT = config.intEnv('PORT', config.intEnv('RENDER_INGRESS_PORT', 8081, 1, 65535), 1, 65535);
const BOOK_SIDECAR_URL = config
  .optionalEnv('BOOK_REPLICA_SIDECAR_INTERNAL_URL', 'http://127.0.0.1:5104')
  .replace(/\/+$/, '');
const MEMBER_SIDECAR_URL = config
  .optionalEnv('MEMBER_SIDECAR_INTERNAL_URL', 'http://127.0.0.1:5105')
  .replace(/\/+$/, '');
const SUPERVISOR_STATUS_URL = config.optionalEnv(
  'RENDER_SUPERVISOR_STATUS_URL',
  'http://127.0.0.1:5300/status'
);
const SUPERVISOR_TOKEN = config.readEnv('RENDER_SUPERVISOR_TOKEN');
const REQUIRE_HMAC = config.boolEnv('RENDER_INGRESS_REQUIRE_HMAC', true);
const PUBLIC_BASE_URL = config.optionalEnv('RENDER_PUBLIC_BASE_URL', `http://render-web:${PORT}`).replace(/\/+$/, '');
const HMAC_SECRET = config.readEnv('AWS_TO_RENDER_HMAC_SECRET');
// The API Gateway calls both Render routes. Borrow Service calls the member
// route directly to validate a member before creating a borrow. Both clients
// use the same AWS->Render secret, but each request is individually signed.
const ALLOWED_CLIENTS = config
  .optionalEnv('RENDER_INGRESS_ALLOWED_CLIENTS', 'api-gateway,borrow-service')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const nonceStore = new hmac.NonceStore();
const stats = new metrics.Metrics(COMPONENT);

let supervisorStatus = null;
let supervisorReachable = false;
let lastSupervisorCheck = null;
let lastSupervisorError = null;

async function refreshSupervisorStatus() {
  const result = await http.requestJson(SUPERVISOR_STATUS_URL, {
    headers: SUPERVISOR_TOKEN ? { 'x-admin-token': SUPERVISOR_TOKEN } : {},
    timeoutMs: 1500,
    retries: 0
  });
  lastSupervisorCheck = new Date().toISOString();
  if (result.ok && result.json && result.json.data) {
    supervisorStatus = result.json.data;
    supervisorReachable = true;
    lastSupervisorError = null;
  } else {
    supervisorReachable = false;
    lastSupervisorError = result.error || `http_${result.status}`;
  }
}

function processSummary() {
  if (!supervisorStatus || !Array.isArray(supervisorStatus.processes)) {
    return { total: 0, running: 0, restarting: 0, stopped: 0, unknown: true };
  }
  const summary = { total: supervisorStatus.processes.length, running: 0, restarting: 0, stopped: 0, unknown: false };
  for (const process of supervisorStatus.processes) {
    if (process.state === 'running') summary.running += 1;
    else if (process.state === 'restarting') summary.restarting += 1;
    else summary.stopped += 1;
  }
  return summary;
}

function ingressHealthy() {
  const summary = processSummary();
  return supervisorReachable && summary.running === summary.total && summary.total > 0;
}

function filterHeaders(req) {
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

async function forwardToSidecar(req, res, { prefix, internalUrl, routeName }) {
  const startedAt = process.hrtime.bigint();
  if (REQUIRE_HMAC) {
    const verification = hmac.verifyExpressRequest(req, {
      secret: HMAC_SECRET,
      nonceStore,
      maxSkewMs: config.intEnv('HMAC_MAX_SKEW_MS', 300000, 1000, 3600000)
    });
    if (!verification.ok || !ALLOWED_CLIENTS.includes(verification.client)) {
      stats.inc('auth_failures');
      agent.reportEvent({
        severity: 'warn',
        type: 'auth_failure',
        message: 'Render ingress rejected an unsigned cross-cloud request',
        details: {
          reason: verification.ok ? 'client_not_allowed' : verification.reason,
          client: verification.client || null,
          path: req.originalUrl
        }
      });
      stats.recordRequest(401, Number(process.hrtime.bigint() - startedAt) / 1e6);
      return respond.fail(res, 401, 'HMAC_AUTH_FAILED', 'Cross-cloud request signature is missing or invalid');
    }
  }

  const strippedPath = req.originalUrl.slice(prefix.length) || '/';
  const targetUrl = `${internalUrl}${strippedPath.startsWith('/') ? '' : '/'}${strippedPath}`;
  const headers = filterHeaders(req);
  headers['x-request-id'] = req.id;
  headers['x-render-ingress'] = 'true';
  headers['x-render-route'] = routeName;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.intEnv('RENDER_INGRESS_TIMEOUT_MS', 6000, 500, 30000));
  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.body && req.body.length > 0 ? req.body : undefined,
      signal: controller.signal,
      redirect: 'manual'
    });
    const body = Buffer.from(await response.arrayBuffer());
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    stats.recordRequest(response.status, durationMs);
    const responseHeaders = filterResponseHeaders(response.headers);
    responseHeaders['x-render-ingress'] = 'true';
    responseHeaders['x-render-route'] = routeName;
    responseHeaders['x-request-id'] = req.id;
    for (const [name, value] of Object.entries(responseHeaders)) res.setHeader(name, value);
    log.info('ingress_request', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      target: targetUrl,
      status: response.status,
      durationMs: Math.round(durationMs * 100) / 100
    });
    return res.status(response.status).send(body);
  } catch (error) {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const timedOut = error.name === 'AbortError';
    const status = timedOut ? 504 : 502;
    stats.recordRequest(status, durationMs);
    stats.inc(timedOut ? 'timeouts' : 'upstream_errors');
    log.warn('ingress_failed', {
      requestId: req.id,
      route: routeName,
      target: targetUrl,
      timedOut,
      message: error.message
    });
    return respond.fail(
      res,
      status,
      timedOut ? 'SIDECAR_TIMEOUT' : 'SIDECAR_UNAVAILABLE',
      `${routeName} sidecar is unavailable`,
      { target: routeName }
    );
  } finally {
    clearTimeout(timer);
  }
}

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(requestId);
app.use(express.raw({ type: '*/*', limit: '2mb' }));

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    if (!req.originalUrl.startsWith('/book-replica') && !req.originalUrl.startsWith('/member')) return;
    log.info('ingress_completed', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 100) / 100
    });
  });
  next();
});

app.get('/', (req, res) => {
  return respond.ok(res, {
    component: COMPONENT,
    cloud: 'render',
    service: 'One Render Free Web Service',
    routes: {
      '/book-replica/*': 'Book Replica Sidecar -> Book Replica Service',
      '/member/*': 'Member Sidecar -> Member Service'
    },
    internalPortsPrivate: true,
    note: 'All public application traffic is routed through the ingress dispatcher and the appropriate sidecar.'
  });
});

app.get('/health', (req, res) => {
  const summary = processSummary();
  const status = ingressHealthy() ? 'healthy' : supervisorReachable ? 'degraded' : 'unknown';
  return respond.ok(res, {
    component: COMPONENT,
    status,
    cloud: 'render',
    publicPort: PORT,
    bindAddress: '0.0.0.0',
    supervisor: {
      reachable: supervisorReachable,
      lastCheck: lastSupervisorCheck,
      error: lastSupervisorError
    },
    processes: summary,
    processDetails: supervisorStatus ? supervisorStatus.processes : [],
    internalPorts: {
      bookReplicaSidecar: BOOK_SIDECAR_URL,
      memberSidecar: MEMBER_SIDECAR_URL,
      exposedPublicly: false
    }
  });
});

app.get('/metrics', (req, res) => {
  return respond.ok(res, {
    ...stats.snapshot(),
    supervisorReachable,
    processes: processSummary(),
    ingress: {
      publicPort: PORT,
      routes: ['/book-replica', '/member'],
      hmacRequired: REQUIRE_HMAC
    }
  });
});

app.get('/supervisor/status', auth.requireApiKey(SUPERVISOR_TOKEN, 'x-admin-token'), (req, res) => {
  return respond.ok(res, supervisorStatus || { supervisor: null, processes: [] });
});

app.use('/book-replica', asyncHandler(async (req, res) => {
  return forwardToSidecar(req, res, {
    prefix: '/book-replica',
    internalUrl: BOOK_SIDECAR_URL,
    routeName: 'book-replica'
  });
}));

app.use('/member', asyncHandler(async (req, res) => {
  return forwardToSidecar(req, res, {
    prefix: '/member',
    internalUrl: MEMBER_SIDECAR_URL,
    routeName: 'member'
  });
}));

app.use(errors.notFoundHandler);
app.use(errors.errorHandler(log));

const agent = new meshAgent.MeshAgent({
  controlPlaneUrl: config.readEnv('CONTROL_PLANE_URL'),
  serviceToken: config.readEnv('CONTROL_PLANE_SERVICE_TOKEN'),
  component: {
    id: COMPONENT,
    name: 'Render Ingress Dispatcher',
    kind: 'ingress',
    cloud: 'render',
    role: 'ingress',
    baseUrl: PUBLIC_BASE_URL,
    meta: {
      publicPort: PORT,
      bindAddress: '0.0.0.0',
      hmacRequired: REQUIRE_HMAC,
      internalPortsPrivate: true,
      runtime: 'render-container-process'
    }
  },
  getStatus: () => (ingressHealthy() ? 'healthy' : supervisorReachable ? 'degraded' : 'unknown'),
  getMetrics: () => stats.snapshot(),
  getMeta: () => ({
    supervisorReachable,
    lastSupervisorCheck,
    lastSupervisorError,
    processes: processSummary(),
    hmacRequired: REQUIRE_HMAC
  })
});

const server = app.listen(PORT, '0.0.0.0', () => {
  log.info('listening', { port: PORT, bindAddress: '0.0.0.0', cloud: 'render' });
  agent.start();
  void refreshSupervisorStatus();
});

const statusTimer = setInterval(() => {
  void refreshSupervisorStatus();
}, 3000);
statusTimer.unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown_started', { signal });
  clearInterval(statusTimer);
  server.close();
  await agent.stop();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled_rejection', { message: reason instanceof Error ? reason.message : String(reason) });
});
