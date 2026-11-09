'use strict';

/**
 * Circuit breaker with CLOSED -> OPEN -> HALF_OPEN -> CLOSED transitions.
 *
 * The same implementation is used by sidecars (service protection) and by the
 * API Gateway (per remote target protection). This keeps behaviour consistent
 * and makes the dashboard values comparable.
 */

class CircuitBreaker {
  constructor({
    name,
    failureThreshold = 5,
    successThreshold = 2,
    cooldownMs = 10000,
    halfOpenMaxCalls = 1,
    onTransition = null
  } = {}) {
    this.name = name || 'breaker';
    this.failureThreshold = failureThreshold;
    this.successThreshold = successThreshold;
    this.cooldownMs = cooldownMs;
    this.halfOpenMaxCalls = halfOpenMaxCalls;
    this.onTransition = onTransition;

    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.openedAt = null;
    this.halfOpenCalls = 0;
    this.transitions = 0;
    this.lastTransitionAt = null;
    this.lastFailureAt = null;
    this.lastSuccessAt = null;
  }

  updateConfig({ failureThreshold, successThreshold, cooldownMs, halfOpenMaxCalls } = {}) {
    if (Number.isInteger(failureThreshold) && failureThreshold > 0) this.failureThreshold = failureThreshold;
    if (Number.isInteger(successThreshold) && successThreshold > 0) this.successThreshold = successThreshold;
    if (Number.isInteger(cooldownMs) && cooldownMs >= 0) this.cooldownMs = cooldownMs;
    if (Number.isInteger(halfOpenMaxCalls) && halfOpenMaxCalls > 0) this.halfOpenMaxCalls = halfOpenMaxCalls;
  }

  transition(to, reason) {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.transitions += 1;
    this.lastTransitionAt = Date.now();
    if (to === 'OPEN') {
      this.openedAt = Date.now();
      this.halfOpenCalls = 0;
    }
    if (to === 'CLOSED') {
      this.failures = 0;
      this.successes = 0;
      this.openedAt = null;
      this.halfOpenCalls = 0;
    }
    if (to === 'HALF_OPEN') {
      this.halfOpenCalls = 0;
      this.successes = 0;
    }
    if (typeof this.onTransition === 'function') {
      this.onTransition({ name: this.name, from, to, reason, at: this.lastTransitionAt });
    }
  }

  isAvailable(now = Date.now()) {
    // Non-consuming availability check used to build candidate lists. It may
    // move an OPEN breaker to HALF_OPEN once the cooldown has elapsed, but it
    // must not reserve a probe slot.
    if (this.state === 'OPEN') {
      if (this.openedAt !== null && now - this.openedAt >= this.cooldownMs) {
        this.transition('HALF_OPEN', 'cooldown_elapsed');
      } else {
        return false;
      }
    }
    if (this.state === 'HALF_OPEN') {
      return this.halfOpenCalls < this.halfOpenMaxCalls;
    }
    return true;
  }

  canRequest(now = Date.now()) {
    // Reserve a half-open probe slot. Only call this once a request has
    // actually been assigned to the target; otherwise the slot would leak.
    if (!this.isAvailable(now)) return false;
    if (this.state === 'HALF_OPEN') {
      this.halfOpenCalls += 1;
    }
    return true;
  }

  onSuccess() {
    this.lastSuccessAt = Date.now();
    if (this.state === 'HALF_OPEN') {
      // Release the probe slot so the next half-open request can be admitted.
      if (this.halfOpenCalls > 0) this.halfOpenCalls -= 1;
      this.successes += 1;
      if (this.successes >= this.successThreshold) {
        this.transition('CLOSED', 'half_open_success');
      }
      return;
    }
    this.failures = 0;
  }

  onFailure() {
    this.lastFailureAt = Date.now();
    this.failures += 1;
    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenCalls > 0) this.halfOpenCalls -= 1;
      this.transition('OPEN', 'half_open_failure');
      return;
    }
    if (this.state === 'CLOSED' && this.failures >= this.failureThreshold) {
      this.transition('OPEN', 'failure_threshold_reached');
    }
  }

  snapshot() {
    const now = Date.now();
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      failureThreshold: this.failureThreshold,
      successThreshold: this.successThreshold,
      cooldownMs: this.cooldownMs,
      halfOpenCalls: this.halfOpenCalls,
      transitions: this.transitions,
      lastTransitionAt: this.lastTransitionAt,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      retryInMs:
        this.state === 'OPEN' && this.openedAt !== null
          ? Math.max(0, this.cooldownMs - (now - this.openedAt))
          : 0
    };
  }
}

module.exports = { CircuitBreaker };
