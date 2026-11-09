'use strict';

/**
 * Integration test runner for the running local mesh.
 *
 * Prerequisites:
 *   - the split or bundle stack is running
 *   - .env exists (npm run secrets)
 *
 * The runner uses only real HTTP requests and real Docker Compose actions.
 * It never invents metrics or test results. Failures are recorded and the
 * process exits non-zero.
 *
 * Usage:
 *   node tests/integration/run.js
 *   node tests/integration/run.js --safe      # skip destructive tests
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { loadEnv } = require('../../scripts/lib/load-env');
const hmac = require('../../shared/hmac');

const ROOT = path.resolve(__dirname, '..', '..');
loadEnv(path.join(ROOT, '.env'));

const SAFE_MODE = process.argv.includes('--safe');

const GATEWAY_URL = (process.env.GATEWAY_URL || 'http://localhost:8080').replace(/\/+$/, '');
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'http://localhost:3000').replace(/\/+$/, '');
const CP_URL = (process.env.CONTROL_PLANE_HOST_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const INGRESS_URL = (process.env.RENDER_INGRESS_HOST_URL || 'http://127.0.0.1:8081').replace(/\/+$/, '');

const READ_TOKEN = process.env.CONTROL_PLANE_READ_TOKEN;
const SERVICE_TOKEN = process.env.CONTROL_PLANE_SERVICE_TOKEN;
const ADMIN_TOKEN = process.env.CONTROL_PLANE_ADMIN_TOKEN;
const AWS_TO_RENDER = process.env.AWS_TO_RENDER_HMAC_SECRET;
const RENDER_TO_AWS = process.env.RENDER_TO_AWS_HMAC_SECRET;

const results = [];
const startedAt = new Date().toISOString();
let mode = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function http(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 10000
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual'
    });
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, ok: response.ok, headers: response.headers, text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(check, { timeoutMs = 30000, intervalMs = 1000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function compose(args, profile = mode) {
  const command = ['compose', '--profile', profile || 'split', ...args];
  const result = spawnSync('docker', command, { cwd: ROOT, encoding: 'utf8' });
  if (result.error) throw new Error(`docker ${command.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `docker ${command.join(' ')} exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}`
    );
  }
  return result.stdout;
}

async function run(name, fn, { skip = null } = {}) {
  if (skip) {
    results.push({ name, status: 'SKIP', detail: skip, durationMs: 0 });
    console.log(`SKIP  ${name} - ${skip}`);
    return;
  }
  const startedAt = Date.now();
  try {
    await fn();
    const durationMs = Date.now() - startedAt;
    results.push({ name, status: 'PASS', durationMs });
    console.log(`PASS  ${name} (${durationMs} ms)`);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    results.push({ name, status: 'FAIL', detail: error.message, durationMs });
    console.error(`FAIL  ${name} (${durationMs} ms)`);
    console.error(`      ${error.message}`);
  }
}

async function getStatus() {
  const response = await http(`${DASHBOARD_URL}/api/mesh/status`);
  if (!response.ok || !response.json || !response.json.data) {
    throw new Error(`Dashboard status returned HTTP ${response.status}`);
  }
  return response.json.data;
}

async function waitForGatewayWeights(aws, render, timeoutMs = 15000) {
  await waitFor(
    async () => {
      const response = await http(`${GATEWAY_URL}/health`, { timeoutMs: 3000 });
      if (!response.ok || !response.json || !response.json.data) return false;
      const configured = response.json.data.routing && response.json.data.routing.configured;
      return Boolean(configured && configured.aws === aws && configured.render === render);
    },
    { timeoutMs, intervalMs: 500, label: `gateway routing weights ${aws}/${render}` }
  );
}

async function setWeights(aws, render) {
  const response = await http(`${DASHBOARD_URL}/api/routing/book/weights`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-admin-token': ADMIN_TOKEN,
      'x-operator': 'integration-test'
    },
    body: JSON.stringify({ aws, render })
  });
  assert.equal(response.status, 200, `weight update failed with HTTP ${response.status}: ${response.text}`);
  assert.equal(response.json.data.book.aws, aws);
  assert.equal(response.json.data.book.render, render);
  // The gateway polls the Control Plane every two seconds. Wait for the new
  // policy to be applied before the caller sends traffic.
  await waitForGatewayWeights(aws, render);
  return response.json.data;
}

async function restoreWeights() {
  try {
    await setWeights(70, 30);
  } catch {
    // Best effort. A later test will report the real state.
  }
}

async function waitForBookTarget(path, expectedTarget, timeoutMs = 30000) {
  return waitFor(
    async () => {
      const response = await http(`${GATEWAY_URL}${path}`, { timeoutMs: 12000 });
      if (response.status !== 200) return false;
      return response.headers.get('x-mesh-target') === expectedTarget ? response : false;
    },
    { timeoutMs, intervalMs: 1000, label: `${expectedTarget} serving ${path}` }
  );
}

async function getBookRequests(count, concurrency = 5) {
  const responses = [];
  let index = 0;
  async function worker() {
    while (index < count) {
      index += 1;
      responses.push(await http(`${GATEWAY_URL}/api/books?limit=1`, { timeoutMs: 12000 }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker()));
  return responses;
}

function countHeader(responses, header) {
  const counts = {};
  for (const response of responses) {
    const value = response.headers.get(header) || 'none';
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function gatewayMetrics() {
  return http(`${GATEWAY_URL}/metrics`).then((response) => {
    if (!response.ok || !response.json || !response.json.data) {
      throw new Error(`Gateway metrics returned HTTP ${response.status}`);
    }
    return response.json.data;
  });
}

async function waitForBookTargetsReady(timeoutMs = 60000) {
  await waitFor(
    async () => {
      const metrics = await gatewayMetrics();
      const targets = (metrics.routing && metrics.routing.targets) || [];
      return ['book-primary-sidecar', 'book-replica-sidecar'].every((id) => {
        const target = targets.find((item) => item.id === id);
        return target && target.routable && ['healthy', 'degraded'].includes(target.status);
      });
    },
    { timeoutMs, intervalMs: 1000, label: 'both book targets routable in the gateway' }
  );
}

async function main() {
  console.log(`Integration tests against ${GATEWAY_URL} (${SAFE_MODE ? 'safe mode' : 'full mode'})`);

  await run('stack health endpoints', async () => {
    await waitFor(
      async () => {
        const response = await http(`${CP_URL}/health`, { timeoutMs: 3000 });
        return response.status === 200 && response.json && response.json.data;
      },
      { timeoutMs: 120000, intervalMs: 2000, label: 'Control Plane health' }
    );
    const cpHealth = await http(`${CP_URL}/health`);
    mode = cpHealth.json.data.mode;
    assert.ok(['split', 'bundle'].includes(mode), `unexpected mesh mode: ${mode}`);

    await waitFor(
      async () => {
        const response = await http(`${GATEWAY_URL}/health`, { timeoutMs: 3000 });
        return response.status === 200 && response.json && response.json.data;
      },
      { timeoutMs: 120000, intervalMs: 2000, label: 'API Gateway health' }
    );
    await waitFor(
      async () => {
        const response = await http(`${DASHBOARD_URL}/health`, { timeoutMs: 3000 });
        return response.ok && response.json && response.json.data.controlPlane.reachable;
      },
      { timeoutMs: 60000, intervalMs: 2000, label: 'dashboard -> Control Plane' }
    );
    if (mode === 'bundle') {
      await waitFor(
        async () => {
          const response = await http(`${INGRESS_URL}/health`, { timeoutMs: 3000 });
          return response.status === 200 && response.json && response.json.data;
        },
        { timeoutMs: 120000, intervalMs: 2000, label: 'Render ingress health' }
      );
    }
  });

  if (!mode) {
    console.error('Cannot continue without a running Control Plane.');
    process.exit(1);
  }

  await run('all expected components registered and reporting', async () => {
    const status = await waitFor(
      async () => {
        const current = await getStatus();
        const bad = current.expected.filter(
          (item) => !item.registered || item.status === 'unknown' || item.status === 'not_registered'
        );
        return bad.length === 0 ? current : null;
      },
      { timeoutMs: 90000, intervalMs: 2000, label: 'all expected components' }
    );
    const expectedCount = mode === 'bundle' ? 14 : 12;
    assert.equal(status.expected.length, expectedCount, `expected ${expectedCount} components in ${mode} mode`);
    assert.ok(status.mesh.registeredServices >= 5, 'five application services should be registered');
    assert.ok(status.mesh.registeredSidecars >= 5, 'five sidecars should be registered');
    assert.equal(status.expected.filter((item) => item.disconnected).length, 0, 'no component should be disconnected');

    const registry = await http(`${CP_URL}/api/registry/services`, {
      headers: { 'x-read-token': READ_TOKEN }
    });
    assert.equal(registry.status, 200, `registry returned HTTP ${registry.status}`);
    const services = registry.json.data.filter((item) => item.kind === 'service');
    const sidecars = registry.json.data.filter((item) => item.kind === 'sidecar');
    assert.equal(services.length, 5, `expected 5 services, got ${services.length}`);
    assert.equal(sidecars.length, 5, `expected 5 sidecars, got ${sidecars.length}`);
  });

  await run('all five service/sidecar pairs proxy real traffic', async () => {
    // Wait until the gateway has loaded both book targets from the registry.
    await waitForBookTargetsReady();
    try {
      await setWeights(100, 0);
      const aws = await waitForBookTarget('/api/books?limit=5', 'book-primary-sidecar');
      assert.equal(aws.status, 200, `AWS book read returned HTTP ${aws.status}`);
      assert.equal(aws.headers.get('x-mesh-target'), 'book-primary-sidecar');
      assert.equal(aws.headers.get('x-sidecar'), 'book-primary-sidecar');
      assert.ok(Array.isArray(aws.json.data), 'book response should contain an array');

      await setWeights(0, 100);
      const render = await waitForBookTarget('/api/books?limit=5', 'book-replica-sidecar');
      assert.equal(render.status, 200, `Render book read returned HTTP ${render.status}`);
      assert.equal(render.headers.get('x-mesh-target'), 'book-replica-sidecar');
      assert.equal(render.headers.get('x-sidecar'), 'book-replica-sidecar');
      assert.ok(Array.isArray(render.json.data), 'replica response should contain an array');

      const borrows = await http(`${GATEWAY_URL}/api/borrows?limit=5`);
      assert.equal(borrows.status, 200, `borrows returned HTTP ${borrows.status}`);
      assert.equal(borrows.headers.get('x-mesh-target'), 'borrow-sidecar');
      assert.equal(borrows.headers.get('x-sidecar'), 'borrow-sidecar');

      const notifications = await http(`${GATEWAY_URL}/api/notifications?limit=5`);
      assert.equal(notifications.status, 200, `notifications returned HTTP ${notifications.status}`);
      assert.equal(notifications.headers.get('x-mesh-target'), 'notification-sidecar');
      assert.equal(notifications.headers.get('x-sidecar'), 'notification-sidecar');

      const member = await http(`${GATEWAY_URL}/api/members/1`);
      assert.equal(member.status, 200, `member read returned HTTP ${member.status}`);
      assert.equal(member.headers.get('x-mesh-target'), 'member-sidecar');
      assert.equal(member.headers.get('x-sidecar'), 'member-sidecar');
      assert.equal(member.json.data.id, 1);
    } finally {
      await restoreWeights();
    }
  });

  await run('weighted 70/30 book routing', async () => {
    try {
      await setWeights(70, 30);
      const responses = await getBookRequests(200, 8);
      const successes = responses.filter((response) => response.status === 200);
      assert.ok(successes.length >= 190, `expected at least 190 successful reads, got ${successes.length}`);
      const targets = countHeader(successes, 'x-mesh-target');
      const aws = targets['book-primary-sidecar'] || 0;
      const render = targets['book-replica-sidecar'] || 0;
      const total = aws + render;
      assert.equal(total, successes.length, 'every response should identify a book sidecar target');
      const awsPercent = (aws / total) * 100;
      assert.ok(aws >= 1 && render >= 1, `both book targets should be used (aws=${aws}, render=${render})`);
      assert.ok(
        awsPercent >= 55 && awsPercent <= 85,
        `AWS share ${awsPercent.toFixed(1)}% is outside the expected 55-85% band for a 70/30 policy`
      );

      const status = await getStatus();
      assert.equal(status.routing.configured.aws, 70);
      assert.equal(status.routing.configured.render, 30);
      assert.ok(status.routing.observed.aws + status.routing.observed.render > 0, 'observed routing counters should be real');
    } finally {
      await restoreWeights();
    }
  });

  await run('dynamic weight update takes effect', async () => {
    try {
      const before = await getStatus();
      const awsVersion = before.routing.version;

      await setWeights(100, 0);
      const awsResponses = await getBookRequests(30, 5);
      const awsTargets = countHeader(awsResponses.filter((response) => response.status === 200), 'x-mesh-target');
      assert.equal(awsTargets['book-primary-sidecar'], 30, 'all reads should use the AWS sidecar at 100/0');

      await setWeights(0, 100);
      const renderResponses = await getBookRequests(30, 5);
      const renderTargets = countHeader(renderResponses.filter((response) => response.status === 200), 'x-mesh-target');
      assert.equal(renderTargets['book-replica-sidecar'], 30, 'all reads should use the Render sidecar at 0/100');

      const after = await getStatus();
      assert.ok(after.routing.version > awsVersion, 'routing version should increase after weight updates');
      assert.equal(after.routing.configured.aws, 0);
      assert.equal(after.routing.configured.render, 100);
    } finally {
      await restoreWeights();
    }
  });

  await run('Redis cache hit and PostgreSQL fallback', async () => {
    try {
      await setWeights(100, 0);
      await http(`${GATEWAY_URL}/api/books/1`);
      const second = await http(`${GATEWAY_URL}/api/books/1`);
      assert.equal(second.status, 200);
      assert.equal(second.json.meta.cache, 'hit', 'the second read should come from Redis');

      if (SAFE_MODE) {
        console.log('      destructive Redis outage skipped in --safe mode');
        return;
      }

      compose(['stop', 'redis']);
      await sleep(2500);
      const fallback = await http(`${GATEWAY_URL}/api/books/2`, { timeoutMs: 12000 });
      assert.equal(fallback.status, 200, `DB fallback read returned HTTP ${fallback.status}`);
      assert.equal(fallback.json.meta.cache, 'fallback', 'the read should report a cache fallback');

      compose(['start', 'redis']);
      await waitFor(
        async () => {
          const status = await getStatus();
          return status.cache.redis.available === true;
        },
        { timeoutMs: 45000, intervalMs: 2000, label: 'Redis recovery through the Cache API' }
      );
      await waitFor(
        async () => {
          const response = await http(`${GATEWAY_URL}/api/books/2`);
          return response.status === 200 && response.json.meta.cache === 'hit';
        },
        { timeoutMs: 20000, intervalMs: 1000, label: 'cache repopulation' }
      );
    } finally {
      await restoreWeights();
    }
  });

  await run('timeout handling under a paused upstream', async () => {
    try {
      await setWeights(100, 0);
      const before = await gatewayMetrics();
      // Pause the sidecar itself so the gateway's own request times out.
      compose(['pause', 'book-primary-sidecar']);
      await sleep(1200);
      const response = await http(`${GATEWAY_URL}/api/books?limit=1`, { timeoutMs: 15000 });
      const after = await gatewayMetrics();
      assert.ok(
        (after.counters.timeouts || 0) > (before.counters.timeouts || 0),
        'the paused sidecar should register at least one real gateway timeout'
      );
      if (response.status === 200) {
        // Health-aware failover to the other book target is a valid outcome.
        assert.equal(response.headers.get('x-mesh-target'), 'book-replica-sidecar');
        assert.equal(response.headers.get('x-mesh-failover'), 'true');
      } else {
        assert.ok([502, 504].includes(response.status), `expected a timeout/unavailable status, got ${response.status}`);
        // The final response can belong to either target: after the paused AWS
        // upstream times out, the gateway may have already failed over to the
        // replica before the last attempt also failed.
        assert.ok(
          ['book-primary-sidecar', 'book-replica-sidecar'].includes(response.headers.get('x-mesh-target')),
          `unexpected x-mesh-target: ${response.headers.get('x-mesh-target')}`
        );
      }
    } finally {
      try {
        compose(['unpause', 'book-primary-sidecar']);
      } catch {
        // Best effort.
      }
      await sleep(7000);
      await restoreWeights();
    }
  }, { skip: SAFE_MODE ? 'destructive test skipped in --safe mode' : null });

  await run('circuit breaker and health-aware failover', async () => {
    try {
      await setWeights(70, 30);
      compose(['stop', 'book-service']);
      await sleep(1500);

      const responses = await getBookRequests(40, 5);
      const targets = countHeader(responses, 'x-mesh-target');
      const render = targets['book-replica-sidecar'] || 0;
      const failovers = responses.filter((response) => response.headers.get('x-mesh-failover') === 'true').length;
      assert.ok(render > 0, `Render should receive failover traffic (targets: ${JSON.stringify(targets)})`);
      assert.ok(failovers > 0, 'at least one request should report an explicit failover');

      const metrics = await gatewayMetrics();
      const awsTarget = metrics.routing.targets.find((target) => target.id === 'book-primary-sidecar');
      assert.ok(awsTarget, 'gateway metrics should include the AWS book target');
      assert.equal(awsTarget.breaker.state, 'OPEN', 'the AWS target breaker should open after repeated failures');
    } finally {
      try {
        compose(['start', 'book-service']);
      } catch {
        // Best effort.
      }
      await restoreWeights();
    }

    await waitFor(
      async () => {
        const response = await http(`${GATEWAY_URL}/health`);
        return response.ok && response.json.data.routing.routableTargets >= 2;
      },
      { timeoutMs: 60000, intervalMs: 2000, label: 'both book targets routable again' }
    );
    await waitFor(
      async () => {
        const responses = await getBookRequests(6, 3);
        const targets = countHeader(responses.filter((response) => response.status === 200), 'x-mesh-target');
        return (targets['book-primary-sidecar'] || 0) > 0;
      },
      { timeoutMs: 45000, intervalMs: 3000, label: 'AWS target recovery after breaker cooldown' }
    );
  }, { skip: SAFE_MODE ? 'destructive test skipped in --safe mode' : null });

  await run('cross-cloud HMAC enforcement', async () => {
    const unsigned = await http(`${GATEWAY_URL}/cross-cloud/books?limit=1`);
    assert.equal(unsigned.status, 401, 'gateway must reject unsigned Render->AWS requests');

    const signedHeaders = hmac.sign({
      secret: RENDER_TO_AWS,
      client: 'book-replica-service',
      method: 'GET',
      path: '/cross-cloud/books?limit=1'
    });
    const signed = await http(`${GATEWAY_URL}/cross-cloud/books?limit=1`, { headers: signedHeaders });
    assert.equal(signed.status, 200, `signed Render->AWS request returned HTTP ${signed.status}`);

    const replay = await http(`${GATEWAY_URL}/cross-cloud/books?limit=1`, { headers: signedHeaders });
    assert.equal(replay.status, 401, 'a replayed nonce must be rejected');

    if (mode === 'bundle') {
      const unsignedIngress = await http(`${INGRESS_URL}/book-replica/api/books?limit=1`);
      assert.equal(unsignedIngress.status, 401, 'ingress must reject unsigned AWS->Render requests');

      const ingressHeaders = hmac.sign({
        secret: AWS_TO_RENDER,
        client: 'api-gateway',
        method: 'GET',
        path: '/book-replica/api/books?limit=1'
      });
      // After the destructive circuit-breaker test the Render sidecar's own
      // breaker may still be cooling down. Wait for a genuinely signed request
      // to succeed instead of treating a transient 503 as an HMAC failure.
      let acceptedHeaders = ingressHeaders;
      const ingressSigned = await waitFor(
        async () => {
          acceptedHeaders = hmac.sign({
            secret: AWS_TO_RENDER,
            client: 'api-gateway',
            method: 'GET',
            path: '/book-replica/api/books?limit=1'
          });
          const response = await http(`${INGRESS_URL}/book-replica/api/books?limit=1`, {
            headers: acceptedHeaders
          });
          return response.status === 200 ? response : false;
        },
        { timeoutMs: 45000, intervalMs: 1000, label: 'signed ingress book request recovery' }
      );
      assert.equal(ingressSigned.status, 200, `signed ingress request returned HTTP ${ingressSigned.status}`);
      assert.equal(ingressSigned.headers.get('x-render-ingress'), 'true');

      const ingressReplay = await http(`${INGRESS_URL}/book-replica/api/books?limit=1`, {
        headers: acceptedHeaders
      });
      assert.equal(ingressReplay.status, 401, 'ingress must reject a replayed nonce');

      const memberHeaders = hmac.sign({
        secret: AWS_TO_RENDER,
        client: 'borrow-service',
        method: 'GET',
        path: '/member/api/members/1'
      });
      const member = await http(`${INGRESS_URL}/member/api/members/1`, { headers: memberHeaders });
      assert.equal(member.status, 200, `borrow-service signed member request returned HTTP ${member.status}`);
    }
  });

  await run('dashboard reflects real request metrics', async () => {
    const before = await getStatus();
    await getBookRequests(10, 5);
    await sleep(4000);
    const after = await getStatus();
    assert.ok(
      after.mesh.totalRequests >= before.mesh.totalRequests + 10,
      `gateway request counter did not grow (before=${before.mesh.totalRequests}, after=${after.mesh.totalRequests})`
    );
    assert.ok(after.mesh.avgLatencyMs > 0, 'average latency should be calculated from real requests');
    assert.ok(after.events.length > 0, 'the dashboard should show real Control Plane events');
    assert.ok(after.components.length >= 9, 'the dashboard should show the registered components');
    assert.ok(after.generatedAt, 'the dashboard status should include a generatedAt timestamp');
  });

  await run('events and alerts endpoints', async () => {
    const events = await http(`${DASHBOARD_URL}/api/events?limit=50`);
    assert.equal(events.status, 200);
    assert.ok(Array.isArray(events.json.data));
    assert.ok(events.json.data.length > 0, 'events should be recorded');
    const types = new Set(events.json.data.map((event) => event.type));
    assert.ok(types.has('service_registered'), 'service_registered events should exist');
    assert.ok(types.has('traffic_weight_change'), 'traffic_weight_change events should exist');

    const alerts = await http(`${DASHBOARD_URL}/api/alerts`);
    assert.equal(alerts.status, 200);
    assert.ok(Array.isArray(alerts.json.data));
  });

  await run('Control Plane survives a PostgreSQL outage', async () => {
    try {
      compose(['stop', 'postgres']);
      await sleep(2500);

      const event = await http(`${CP_URL}/api/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-token': SERVICE_TOKEN },
        body: JSON.stringify({
          severity: 'info',
          type: 'integration_test',
          source: 'integration-test',
          cloud: 'aws',
          message: 'Control Plane database outage test event',
          details: { test: 'db-outage' }
        })
      });
      assert.equal(event.status, 201, `in-memory event write returned HTTP ${event.status}`);

      const health = await waitFor(
        async () => {
          const response = await http(`${CP_URL}/health`);
          return response.status === 200 && response.json && response.json.data.database.connected === false
            ? response
            : null;
        },
        { timeoutMs: 25000, intervalMs: 1000, label: 'Control Plane database disconnection' }
      );
      assert.equal(health.status, 200, 'Control Plane should stay up without PostgreSQL');

      const status = await getStatus();
      assert.equal(status.database.connected, false, 'dashboard should show the database outage');
    } finally {
      try {
        compose(['start', 'postgres']);
      } catch {
        // Best effort.
      }
    }

    await waitFor(
      async () => {
        const health = await http(`${CP_URL}/health`);
        return health.status === 200 && health.json.data.database.connected === true;
      },
      { timeoutMs: 60000, intervalMs: 3000, label: 'Control Plane database reconnection' }
    );
    await waitFor(
      async () => {
        const status = await getStatus();
        return status.expected.every((item) => item.registered && item.status !== 'unknown');
      },
      { timeoutMs: 90000, intervalMs: 3000, label: 'services recovered after PostgreSQL restart' }
    );
  }, { skip: SAFE_MODE ? 'destructive test skipped in --safe mode' : null });

  await run('Render supervisor restarts a crashed process', async () => {
    const before = await http(`${INGRESS_URL}/health`);
    assert.equal(before.status, 200);
    const beforeProcess = before.json.data.processDetails.find((item) => item.name === 'member-service');
    assert.ok(beforeProcess, 'supervisor status should include member-service');
    const beforeRestarts = beforeProcess.restarts || 0;

    compose(['exec', '-T', 'render-web', 'node', 'scripts/kill-render-process.js', 'member-service']);
    await waitFor(
      async () => {
        const response = await http(`${INGRESS_URL}/health`);
        const process = response.json.data.processDetails.find((item) => item.name === 'member-service');
        return process && process.state === 'running' && (process.restarts || 0) > beforeRestarts;
      },
      { timeoutMs: 30000, intervalMs: 2000, label: 'supervisor restart of member-service' }
    );

    const after = await http(`${INGRESS_URL}/health`);
    assert.equal(after.json.data.processes.running, 5, 'all five supervised processes should be running again');
    assert.equal(after.json.data.processes.total, 5, 'the bundle should supervise five processes');
  }, {
    skip: mode !== 'bundle'
      ? 'bundle mode only'
      : SAFE_MODE
        ? 'destructive test skipped in --safe mode'
        : null
  });

  await run('secrets are not exposed to the browser', async () => {
    const secrets = [
      READ_TOKEN,
      SERVICE_TOKEN,
      ADMIN_TOKEN,
      AWS_TO_RENDER,
      RENDER_TO_AWS,
      process.env.AWS_DB_PASSWORD,
      process.env.RENDER_DB_PASSWORD,
      process.env.POSTGRES_ADMIN_PASSWORD,
      process.env.REDIS_PASSWORD,
      process.env.CACHE_API_KEY,
      process.env.RENDER_SUPERVISOR_TOKEN
    ].filter(Boolean);

    const html = await http(`${DASHBOARD_URL}/`);
    assert.equal(html.status, 200);
    const scriptSources = [...html.text.matchAll(/src="([^"]+)"/g)].map((match) => match[1]);
    const bodies = [html.text];
    for (const source of scriptSources) {
      const asset = await http(`${DASHBOARD_URL}${source.startsWith('/') ? source : `/${source}`}`);
      if (asset.ok) bodies.push(asset.text);
    }
    for (const secret of secrets) {
      for (const body of bodies) {
        assert.ok(!body.includes(secret), 'a server-side secret leaked into a browser asset');
      }
    }
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(html.headers.get('x-frame-options'), 'DENY');
  });

  await run('unauthorized access is rejected', async () => {
    const cpStatus = await http(`${CP_URL}/api/mesh/status`);
    assert.equal(cpStatus.status, 401, 'Control Plane read endpoint must require a token');

    const unauthorizedWeight = await http(`${DASHBOARD_URL}/api/routing/book/weights`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aws: 50, render: 50 })
    });
    assert.equal(unauthorizedWeight.status, 401, 'weight updates must require an admin token');

    const unsignedGateway = await http(`${GATEWAY_URL}/cross-cloud/books?limit=1`);
    assert.equal(unsignedGateway.status, 401, 'cross-cloud gateway route must require HMAC');
  });

  await run('internal ports are not published on the host', async () => {
    const internalPorts = [5432, 6379, 4100, 4101, 4102, 4103, 4104, 4105, 5101, 5102, 5103, 5104, 5105, 5300];
    const reachable = [];
    for (const port of internalPorts) {
      try {
        const response = await http(`http://127.0.0.1:${port}/health`, { timeoutMs: 700 });
        reachable.push(`${port} (HTTP ${response.status})`);
      } catch {
        // Expected: the port is not published.
      }
    }
    assert.deepEqual(reachable, [], `internal ports unexpectedly reachable: ${reachable.join(', ')}`);
  });

  await run('final mesh health', async () => {
    const status = await waitFor(
      async () => {
        const current = await getStatus();
        return current.expected.every(
          (item) => item.registered && item.status !== 'unknown' && item.status !== 'not_registered'
        )
          ? current
          : null;
      },
      { timeoutMs: 90000, intervalMs: 3000, label: 'final healthy mesh' }
    );
    assert.ok(status.mesh.healthy >= 5, 'at least five components should be healthy');
    assert.equal(status.routing.configured.aws, 70, 'weights should be restored to 70/30');
    assert.equal(status.routing.configured.render, 30, 'weights should be restored to 70/30');
  });

  const summary = {
    total: results.length,
    passed: results.filter((item) => item.status === 'PASS').length,
    failed: results.filter((item) => item.status === 'FAIL').length,
    skipped: results.filter((item) => item.status === 'SKIP').length
  };

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    mode,
    safeMode: SAFE_MODE,
    gateway: GATEWAY_URL,
    summary,
    results
  };
  const reportDir = path.join(__dirname, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'last-run.json'), JSON.stringify(report, null, 2));

  console.log('');
  console.log(`Integration summary: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped.`);
  console.log(`Report: ${path.relative(ROOT, path.join(reportDir, 'last-run.json'))}`);

  if (summary.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`Integration runner crashed: ${error.message}`);
  process.exit(1);
});
