'use strict';

/**
 * Small in-process metrics collector.
 *
 * All values are real observations. There is no synthetic or random data.
 * Latency percentiles are calculated from a bounded ring buffer of recent
 * samples, which keeps memory usage predictable.
 */

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

class Metrics {
  constructor(component, { latencyWindow = 2000, rpsWindowMs = 10000 } = {}) {
    this.component = component;
    this.startedAt = Date.now();
    this.counters = Object.create(null);
    this.gauges = Object.create(null);
    this.latencySamples = [];
    this.latencyWindow = latencyWindow;
    this.requestTimestamps = [];
    this.rpsWindowMs = rpsWindowMs;
    this.requests = 0;
    this.errors = 0;
    this.statusCodes = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  }

  inc(name, amount = 1) {
    this.counters[name] = (this.counters[name] || 0) + amount;
  }

  gauge(name, value) {
    this.gauges[name] = value;
  }

  recordRequest(status, durationMs) {
    this.requests += 1;
    if (status >= 500 || status === 0) this.errors += 1;
    const bucket = `${Math.floor(status / 100)}xx`;
    if (this.statusCodes[bucket] !== undefined) this.statusCodes[bucket] += 1;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      this.latencySamples.push(durationMs);
      if (this.latencySamples.length > this.latencyWindow) this.latencySamples.shift();
    }
    const now = Date.now();
    this.requestTimestamps.push(now);
    const cutoff = now - this.rpsWindowMs;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < cutoff) {
      this.requestTimestamps.shift();
    }
  }

  snapshot() {
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    const uptimeMs = Math.max(1, Date.now() - this.startedAt);
    const rpsWindow = Math.min(this.rpsWindowMs, uptimeMs) / 1000;
    return {
      component: this.component,
      uptimeSeconds: round(uptimeMs / 1000, 1),
      requests: this.requests,
      errors: this.errors,
      errorRate: this.requests === 0 ? 0 : round(this.errors / this.requests, 4),
      statusCodes: { ...this.statusCodes },
      latency: {
        count: sorted.length,
        avgMs: sorted.length === 0 ? 0 : round(sum / sorted.length),
        p50Ms: round(percentile(sorted, 50)),
        p95Ms: round(percentile(sorted, 95)),
        p99Ms: round(percentile(sorted, 99)),
        maxMs: round(sorted.length === 0 ? 0 : sorted[sorted.length - 1])
      },
      requestsPerSecond: round(this.requestTimestamps.length / Math.max(1, rpsWindow), 2),
      counters: { ...this.counters },
      gauges: { ...this.gauges }
    };
  }
}

module.exports = { Metrics, percentile };
