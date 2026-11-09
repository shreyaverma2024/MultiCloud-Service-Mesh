'use strict';

/**
 * Real traffic generator for the local mesh.
 *
 * Every request goes through the API Gateway, which routes it through the
 * appropriate sidecar. No metrics are fabricated: the summary is calculated
 * only from actual HTTP responses.
 *
 * Environment:
 *   GATEWAY_URL       default http://localhost:8080
 *   DURATION_SECONDS  default 30
 *   CONCURRENCY       default 5
 *   DELAY_MS          default 50
 */

const { loadEnv } = require('./lib/load-env');

loadEnv();

const GATEWAY_URL = (process.env.GATEWAY_URL || 'http://localhost:8080').replace(/\/+$/, '');
const DURATION_SECONDS = Math.max(1, Number(process.env.DURATION_SECONDS || 30));
const CONCURRENCY = Math.max(1, Math.min(50, Number(process.env.CONCURRENCY || 5)));
const DELAY_MS = Math.max(0, Number(process.env.DELAY_MS || 50));

const stats = {
  total: 0,
  ok: 0,
  failed: 0,
  byStatus: {},
  byTarget: {},
  byCloud: {},
  latencies: [],
  startedAt: new Date().toISOString()
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function chooseRequest() {
  const value = Math.random();
  if (value < 0.5) return { method: 'GET', path: '/api/books?limit=10' };
  if (value < 0.7) return { method: 'GET', path: `/api/books/${1 + Math.floor(Math.random() * 12)}` };
  if (value < 0.82) return { method: 'GET', path: '/api/borrows?limit=10' };
  if (value < 0.94) return { method: 'GET', path: `/api/members/${1 + Math.floor(Math.random() * 5)}` };
  return {
    method: 'POST',
    path: '/api/borrows',
    body: JSON.stringify({
      memberId: 1 + Math.floor(Math.random() * 5),
      bookId: 1 + Math.floor(Math.random() * 12),
      days: 7
    })
  };
}

async function oneRequest() {
  const request = chooseRequest();
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${GATEWAY_URL}${request.path}`, {
      method: request.method,
      headers: request.body ? { 'content-type': 'application/json' } : undefined,
      body: request.body,
      signal: controller.signal,
      redirect: 'manual'
    });
    await response.arrayBuffer();
    const durationMs = Date.now() - startedAt;
    stats.total += 1;
    stats.latencies.push(durationMs);
    increment(stats.byStatus, String(response.status));
    increment(stats.byTarget, response.headers.get('x-mesh-target') || 'unknown');
    increment(stats.byCloud, response.headers.get('x-mesh-cloud') || 'unknown');
    if (response.ok) stats.ok += 1;
    else stats.failed += 1;
  } catch (error) {
    stats.total += 1;
    stats.failed += 1;
    increment(stats.byStatus, 'network_error');
    stats.latencies.push(Date.now() - startedAt);
    if (stats.total % 25 === 0) {
      console.warn(`request error: ${error.name === 'AbortError' ? 'timeout' : error.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function worker(deadline) {
  while (Date.now() < deadline) {
    await oneRequest();
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function printSummary(final = false) {
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const summary = {
    final,
    gateway: GATEWAY_URL,
    elapsedSeconds: Math.round((Date.now() - Date.parse(stats.startedAt)) / 1000),
    total: stats.total,
    ok: stats.ok,
    failed: stats.failed,
    errorRate: stats.total > 0 ? Math.round((stats.failed / stats.total) * 10000) / 100 : 0,
    statusCodes: stats.byStatus,
    targets: stats.byTarget,
    clouds: stats.byCloud,
    latency: {
      avgMs: sorted.length ? Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) : 0,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      maxMs: sorted.length ? sorted[sorted.length - 1] : 0
    }
  };
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  const deadline = Date.now() + DURATION_SECONDS * 1000;
  const progressTimer = setInterval(() => printSummary(false), 5000);
  progressTimer.unref();

  console.log(
    `Generating real traffic for ${DURATION_SECONDS}s with concurrency ${CONCURRENCY} against ${GATEWAY_URL}`
  );
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(deadline)));
  clearInterval(progressTimer);
  printSummary(true);

  if (stats.total === 0) process.exit(1);
  if (stats.failed === stats.total) process.exit(1);
}

main().catch((error) => {
  console.error(`Traffic generator failed: ${error.message}`);
  process.exit(1);
});
