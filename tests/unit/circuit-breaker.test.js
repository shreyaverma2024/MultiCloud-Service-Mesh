'use strict';

const { CircuitBreaker } = require('../../shared/circuit-breaker');

describe('CircuitBreaker', () => {
  test('opens after the configured number of failures', () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 3, cooldownMs: 1000 });
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.state).toBe('CLOSED');
    breaker.onFailure();
    expect(breaker.state).toBe('OPEN');
    expect(breaker.canRequest()).toBe(false);
  });

  test('moves to HALF_OPEN after cooldown and closes after successes', () => {
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      successThreshold: 2,
      cooldownMs: 1000
    });
    breaker.onFailure();
    expect(breaker.state).toBe('OPEN');

    const later = Date.now() + 1001;
    expect(breaker.canRequest(later)).toBe(true);
    expect(breaker.state).toBe('HALF_OPEN');

    breaker.onSuccess();
    expect(breaker.state).toBe('HALF_OPEN');
    breaker.onSuccess();
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.snapshot().failures).toBe(0);
  });

  test('reopens when a half-open probe fails', () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1, cooldownMs: 1 });
    breaker.onFailure();
    expect(breaker.canRequest(Date.now() + 10)).toBe(true);
    expect(breaker.state).toBe('HALF_OPEN');
    breaker.onFailure();
    expect(breaker.state).toBe('OPEN');
  });

  test('limits concurrent half-open probes', () => {
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      cooldownMs: 1,
      halfOpenMaxCalls: 1
    });
    breaker.onFailure();
    expect(breaker.canRequest(Date.now() + 10)).toBe(true);
    expect(breaker.canRequest(Date.now() + 10)).toBe(false);
  });

  test('isAvailable does not consume half-open probe slots', () => {
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      cooldownMs: 1,
      halfOpenMaxCalls: 1
    });
    breaker.onFailure();
    const later = Date.now() + 10;
    expect(breaker.isAvailable(later)).toBe(true);
    expect(breaker.isAvailable(later)).toBe(true);
    expect(breaker.canRequest(later)).toBe(true);
    expect(breaker.canRequest(later)).toBe(false);
  });

  test('releases the half-open probe slot after each request', () => {
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      successThreshold: 3,
      cooldownMs: 1,
      halfOpenMaxCalls: 1
    });
    breaker.onFailure();
    const later = Date.now() + 10;
    expect(breaker.canRequest(later)).toBe(true);
    expect(breaker.canRequest(later)).toBe(false);

    breaker.onSuccess();
    expect(breaker.canRequest(later)).toBe(true);
    breaker.onSuccess();
    expect(breaker.canRequest(later)).toBe(true);
    breaker.onSuccess();
    expect(breaker.state).toBe('CLOSED');
  });
});
