'use strict';

const { Metrics, percentile } = require('../../shared/metrics');

describe('Metrics', () => {
  test('counts requests, errors and status buckets', () => {
    const metrics = new Metrics('test');
    metrics.recordRequest(200, 10);
    metrics.recordRequest(201, 20);
    metrics.recordRequest(503, 30);
    metrics.inc('cache_hits');
    metrics.inc('cache_hits');
    metrics.gauge('queue', 4);

    const snapshot = metrics.snapshot();
    expect(snapshot.requests).toBe(3);
    expect(snapshot.errors).toBe(1);
    expect(snapshot.errorRate).toBeCloseTo(0.3333, 3);
    expect(snapshot.statusCodes).toEqual({ '2xx': 2, '3xx': 0, '4xx': 0, '5xx': 1 });
    expect(snapshot.counters.cache_hits).toBe(2);
    expect(snapshot.gauges.queue).toBe(4);
    expect(snapshot.latency.avgMs).toBe(20);
  });

  test('calculates bounded percentiles', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });

  test('uses real latency samples for p95', () => {
    const metrics = new Metrics('test');
    for (let index = 1; index <= 100; index += 1) metrics.recordRequest(200, index);
    const snapshot = metrics.snapshot();
    expect(snapshot.latency.p95Ms).toBe(95);
    expect(snapshot.latency.maxMs).toBe(100);
  });
});
