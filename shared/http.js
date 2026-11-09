'use strict';

/** Fetch wrapper with explicit timeouts and optional bounded retries. */

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIdempotentMethod(method) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase());
}

async function requestJson(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    buildHeaders = null,
    body,
    timeoutMs = 3000,
    retries = 0,
    retryDelayMs = 100,
    retryOnStatus = [502, 503, 504],
    idempotent = isIdempotentMethod(method)
  } = options;

  let attempt = 0;
  let lastResult = null;

  while (attempt <= retries) {
    attempt += 1;
    // Signed requests must be re-signed on every attempt: a nonce may only be
    // used once, so reusing the headers would be rejected as a replay.
    const attemptHeaders =
      typeof buildHeaders === 'function' ? { ...headers, ...buildHeaders(attempt) } : headers;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        method,
        headers: attemptHeaders,
        body,
        signal: controller.signal,
        redirect: 'manual'
      });
      clearTimeout(timer);
      const text = await response.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      lastResult = {
        ok: response.ok,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        text,
        json,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
        timedOut: false
      };

      if (
        attempt <= retries &&
        idempotent &&
        retryOnStatus.includes(response.status)
      ) {
        await delay(retryDelayMs * attempt);
        continue;
      }
      return lastResult;
    } catch (error) {
      clearTimeout(timer);
      const timedOut = error.name === 'AbortError';
      lastResult = {
        ok: false,
        status: 0,
        headers: {},
        text: '',
        json: null,
        error: timedOut ? 'timeout' : error.message,
        timedOut,
        attempts: attempt,
        durationMs: Date.now() - startedAt
      };
      if (attempt <= retries && idempotent) {
        await delay(retryDelayMs * attempt);
        continue;
      }
      return lastResult;
    }
  }

  return lastResult;
}

module.exports = { requestJson, delay, isIdempotentMethod };
