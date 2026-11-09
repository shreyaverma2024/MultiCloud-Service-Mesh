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
  requestId,
  securityHeaders,
  asyncHandler
} = require('./index');

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length'
]);

const INTERNAL_AUTH_HEADERS = new Set([
  'x-admin-token',
  'x-service-token',
  'x-read-token',
  'authorization'
]);

function filterRequestHeaders(req) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (INTERNAL_AUTH_HEADERS.has(lower)) continue;
    headers[lower] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

function filterResponseHeaders(headers) {
  const output = {};
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'content-encoding' || lower === 'content-length') continue;
    output[lower] = value;
  }
  return output;
}

async function forwardOnce(url, method, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method,
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
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      ok: false,
      timedOut: error.name === 'AbortError',
      error: error.name === 'AbortError' ? 'upstream_timeout' : error.message,
      durationMs: Date.now() - startedAt
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Creates a real HTTP reverse-proxy sidecar.
 *
 * Each sidecar is a separate process/container with its own port, upstream,
 * health state, circuit breaker and metrics. It registers with the Control
 * Plane and retains its last valid configuration if the Control Plane is down.
 */
function createSidecar({
  name,
  port,
  cloud,
  role,
  serviceName,
  upstreamUrl,
  controlPlaneUrl,
  serviceToken,
  advertiseUrl,
  verifyHmac = null
}) {
  const log = logger.child(name);
  const stats = new metrics.Metrics(name);
  const nonceStore = new hmac.NonceStore();

  let currentConfig = {
    timeoutMs: config.intEnv('SIDECAR_TIMEOUT_MS', 2000, 200, 30000),
    retries: config.intEnv('SIDECAR_RETRIES', 2, 0, 5),
    retryDelayMs: config.intEnv('SIDECAR_RETRY_DELAY_MS', 100, 0, 5000),
    circuitBreaker: {
      failureThreshold: config.intEnv('SIDECAR_BREAKER_FAILURES', 5, 1, 100),
      successThreshold: config.intEnv('SIDECAR_BREAKER_SUCCESSES', 2, 1, 20),
      cooldownMs: config.intEnv('SIDECAR_BREAKER_COOLDOWN_MS', 10000, 1000, 300000),
      halfOpenMaxCalls: 1
    }
  };
  let configVersion = 'local';

  let upstreamHealthy = false;
  let lastUpstreamCheck = null;
  let lastUpstreamError = null;
  let lastUpstreamStatus = 'unknown';

  const breaker = new circuitBreaker.CircuitBreaker({
    name: `${name}->${serviceName}`,
    ...currentConfig.circuitBreaker,
    onTransition: (event) => {
      stats.inc('circuit_transitions');
      stats.inc(`circuit_${event.to.toLowerCase()}`);
      log.warn('circuit_breaker_transition', event);
      agent.reportEvent({
        severity: event.to === 'OPEN' ? 'warn' : 'info',
        type: 'circuit_breaker_transition',
        message: `${name} circuit breaker changed from ${event.from} to ${event.to}`,
        details: event
      });
    }
  });

  const agent = new meshAgent.MeshAgent({
    controlPlaneUrl,
    serviceToken,
    componentName: name,
    component: {
      id: name,
      name: `${name} (${cloud})`,
      kind: 'sidecar',
      cloud,
      role,
      baseUrl: advertiseUrl || `http://${name}:${port}`,
      meta: {
        port,
        upstreamUrl,
        serviceName,
        proxy: true,
        runtime: cloud === 'render' ? 'render-container-process' : 'docker-container'
      }
    },
    getStatus: () => {
      if (breaker.state === 'OPEN') return 'degraded';
      return upstreamHealthy ? 'healthy' : 'degraded';
    },
    getMetrics: () => ({
      ...stats.snapshot(),
      breaker: breaker.snapshot(),
      upstream: {
        healthy: upstreamHealthy,
        status: lastUpstreamStatus,
        lastCheck: lastUpstreamCheck,
        error: lastUpstreamError
      },
      configVersion
    }),
    getMeta: () => ({
      upstreamUrl,
      serviceName,
      upstreamHealthy,
      lastUpstreamCheck,
      lastUpstreamError,
      breaker: breaker.snapshot(),
      configVersion
    }),
    onConfig: (data) => {
      if (data && data.config) {
        const next = data.config;
        if (Number.isInteger(next.timeoutMs)) currentConfig.timeoutMs = next.timeoutMs;
        if (Number.isInteger(next.retries)) currentConfig.retries = next.retries;
        if (Number.isInteger(next.retryDelayMs)) currentConfig.retryDelayMs = next.retryDelayMs;
        if (next.circuitBreaker) {
          currentConfig.circuitBreaker = { ...currentConfig.circuitBreaker, ...next.circuitBreaker };
          breaker.updateConfig(currentConfig.circuitBreaker);
        }
        configVersion = String(data.version);
      }
    }
  });

  async function checkUpstream() {
    const result = await fetch(`${upstreamUrl}/health`, {
      signal: AbortSignal.timeout(1500),
      redirect: 'manual'
    }).catch((error) => ({ ok: false, error }));
    lastUpstreamCheck = new Date().toISOString();
    if (result && result.ok) {
      try {
        const json = await result.json();
        lastUpstreamStatus = (json.data && json.data.status) || 'unknown';
        upstreamHealthy = lastUpstreamStatus !== 'unhealthy';
        lastUpstreamError = null;
      } catch {
        upstreamHealthy = false;
        lastUpstreamStatus = 'invalid_response';
        lastUpstreamError = 'invalid_health_response';
      }
    } else {
      upstreamHealthy = false;
      lastUpstreamStatus = 'unreachable';
      lastUpstreamError = result && result.error ? result.error.message || 'unreachable' : 'unreachable';
    }
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(requestId);
  app.use(express.raw({ type: '*/*', limit: '2mb' }));

  app.get('/health', (req, res) => {
    return respond.ok(res, {
      component: name,
      status: 'healthy',
      cloud,
      role,
      service: serviceName,
      upstream: {
        url: upstreamUrl,
        healthy: upstreamHealthy,
        status: lastUpstreamStatus,
        lastCheck: lastUpstreamCheck,
        error: lastUpstreamError
      },
      circuitBreaker: breaker.snapshot(),
      configVersion
    });
  });

  app.get('/ready', (req, res) => {
    if (!upstreamHealthy) {
      return respond.fail(res, 503, 'UPSTREAM_NOT_READY', `${serviceName} is not healthy`);
    }
    if (breaker.state === 'OPEN') {
      return respond.fail(res, 503, 'CIRCUIT_OPEN', 'Circuit breaker is open');
    }
    return respond.ok(res, { ready: true });
  });

  app.get('/metrics', (req, res) => {
    return respond.ok(res, {
      ...stats.snapshot(),
      proxy: {
        name,
        cloud,
        role,
        serviceName,
        upstreamUrl,
        upstreamHealthy,
        lastUpstreamCheck,
        lastUpstreamError,
        configVersion
      },
      circuitBreaker: breaker.snapshot()
    });
  });

  app.use(asyncHandler(async (req, res) => {
    const startedAt = process.hrtime.bigint();
    const requestIdValue = req.id;

    if (verifyHmac && verifyHmac.secret) {
      const verification = hmac.verifyExpressRequest(req, {
        secret: verifyHmac.secret,
        client: verifyHmac.client,
        nonceStore,
        maxSkewMs: config.intEnv('HMAC_MAX_SKEW_MS', 300000, 1000, 3600000)
      });
      if (!verification.ok) {
        stats.inc('auth_failures');
        agent.reportEvent({
          severity: 'warn',
          type: 'auth_failure',
          message: `Rejected unsigned request at ${name}`,
          details: { reason: verification.reason, path: req.originalUrl }
        });
        return respond.fail(res, 401, 'HMAC_AUTH_FAILED', 'Request signature is missing or invalid');
      }
    }

    if (!breaker.canRequest()) {
      stats.inc('circuit_rejections');
      res.setHeader('retry-after', String(Math.ceil(breaker.snapshot().retryInMs / 1000)));
      return respond.fail(res, 503, 'CIRCUIT_OPEN', `${serviceName} circuit breaker is open`, {
        breaker: breaker.snapshot()
      });
    }

    const method = req.method.toUpperCase();
    const idempotent = ['GET', 'HEAD', 'OPTIONS'].includes(method);
    const targetUrl = `${upstreamUrl}${req.originalUrl}`;
    const headers = filterRequestHeaders(req);
    headers['x-request-id'] = requestIdValue;
    headers['x-sidecar'] = name;

    let attempt = 0;
    let result = null;
    const maxAttempts = 1 + (idempotent ? currentConfig.retries : 0);

    while (attempt < maxAttempts) {
      attempt += 1;
      if (attempt > 1) {
        stats.inc('retries');
        await new Promise((resolve) => setTimeout(resolve, currentConfig.retryDelayMs * (attempt - 1)));
      }
      result = await forwardOnce(targetUrl, method, headers, req.body, currentConfig.timeoutMs);
      const retryable = !result.ok || [502, 503, 504].includes(result.status);
      if (!retryable || attempt >= maxAttempts) break;
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    if (!result.ok) {
      stats.inc('upstream_errors');
      if (result.timedOut) stats.inc('timeouts');
      breaker.onFailure();
      const status = result.timedOut ? 504 : 502;
      res.setHeader('x-sidecar', name);
      res.setHeader('x-sidecar-attempts', String(attempt));
      res.setHeader('x-mesh-config-version', configVersion);
      stats.recordRequest(status, durationMs);
      log.warn('proxy_failed', {
        requestId: requestIdValue,
        method,
        path: req.originalUrl,
        target: targetUrl,
        attempts: attempt,
        timedOut: result.timedOut,
        durationMs: Math.round(durationMs * 100) / 100,
        breaker: breaker.state
      });
      return respond.fail(
        res,
        status,
        result.timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
        result.timedOut ? `${serviceName} timed out` : `${serviceName} is unavailable`,
        { attempts: attempt, upstream: serviceName }
      );
    }

    if (result.status >= 500) {
      stats.inc('upstream_errors');
      breaker.onFailure();
    } else {
      breaker.onSuccess();
    }

    stats.inc('proxied_requests');
    stats.recordRequest(result.status, durationMs);
    const responseHeaders = filterResponseHeaders(result.headers);
    responseHeaders['x-sidecar'] = name;
    responseHeaders['x-sidecar-upstream'] = serviceName;
    responseHeaders['x-sidecar-attempts'] = String(attempt);
    responseHeaders['x-mesh-config-version'] = configVersion;
    responseHeaders['x-request-id'] = requestIdValue;
    for (const [header, value] of Object.entries(responseHeaders)) {
      res.setHeader(header, value);
    }
    log.info('proxy_request', {
      requestId: requestIdValue,
      method,
      path: req.originalUrl,
      status: result.status,
      target: targetUrl,
      attempts: attempt,
      durationMs: Math.round(durationMs * 100) / 100,
      breaker: breaker.state
    });
    return res.status(result.status).send(result.body);
  }));

  app.use(errors.notFoundHandler);
  app.use(errors.errorHandler(log));

  const server = app.listen(port, '0.0.0.0', () => {
    log.info('sidecar_listening', {
      port,
      cloud,
      serviceName,
      upstreamUrl,
      advertiseUrl: advertiseUrl || `http://${name}:${port}`
    });
    agent.start();
    void checkUpstream();
  });

  const healthTimer = setInterval(() => {
    void checkUpstream();
  }, 5000);
  healthTimer.unref();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown_started', { signal });
    clearInterval(healthTimer);
    server.close();
    await agent.stop();
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled_rejection', {
      message: reason instanceof Error ? reason.message : String(reason)
    });
  });

  return { app, server, agent, breaker, stats };
}

module.exports = { createSidecar };
