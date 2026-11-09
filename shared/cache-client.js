'use strict';

const { requestJson } = require('./http');

/**
 * HTTP client for the authenticated Cache API.
 *
 * Components never talk to Redis directly. If the Cache API or Redis is
 * unavailable, callers receive { available: false } and must fall back to the
 * authoritative PostgreSQL data source.
 */
class CacheClient {
  constructor({ url, apiKey, timeoutMs = 1500 }) {
    if (!url || !apiKey) throw new Error('Cache API URL and key are required');
    this.url = url.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.stats = { hits: 0, misses: 0, sets: 0, deletes: 0, errors: 0, fallbacks: 0 };
    this.lastError = null;
    this.lastSuccessAt = null;
  }

  headers() {
    return { 'x-api-key': this.apiKey, 'content-type': 'application/json' };
  }

  keyPath(namespace, key) {
    return `${this.url}/cache/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`;
  }

  async get(namespace, key) {
    const result = await requestJson(this.keyPath(namespace, key), {
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      retries: 0
    });
    if (!result.ok || !result.json || !result.json.data) {
      this.stats.errors += 1;
      this.lastError = result.status === 0 ? result.error || 'unreachable' : `http_${result.status}`;
      return { available: false, hit: false, value: null, status: result.status, error: this.lastError };
    }
    this.lastError = null;
    this.lastSuccessAt = Date.now();
    const data = result.json.data;
    if (data.hit) this.stats.hits += 1;
    else this.stats.misses += 1;
    return { available: true, hit: Boolean(data.hit), value: data.value, status: 200 };
  }

  async set(namespace, key, value, ttlSeconds) {
    const result = await requestJson(this.keyPath(namespace, key), {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ value, ttlSeconds }),
      timeoutMs: this.timeoutMs,
      retries: 0
    });
    if (!result.ok) {
      this.stats.errors += 1;
      this.lastError = result.status === 0 ? result.error || 'unreachable' : `http_${result.status}`;
      return { available: false, stored: false };
    }
    this.stats.sets += 1;
    this.lastError = null;
    this.lastSuccessAt = Date.now();
    return { available: true, stored: true };
  }

  async del(namespace, key) {
    const result = await requestJson(this.keyPath(namespace, key), {
      method: 'DELETE',
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      retries: 0
    });
    if (!result.ok) {
      this.stats.errors += 1;
      return { available: false, deleted: false };
    }
    this.stats.deletes += 1;
    return { available: true, deleted: Boolean(result.json && result.json.data && result.json.data.deleted) };
  }

  async invalidate(namespace) {
    const result = await requestJson(`${this.url}/cache/invalidate`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ namespace }),
      timeoutMs: this.timeoutMs,
      retries: 0
    });
    if (!result.ok) {
      this.stats.errors += 1;
      return { available: false, deleted: 0 };
    }
    return {
      available: true,
      deleted: result.json && result.json.data ? result.json.data.deleted : 0
    };
  }

  async health() {
    const result = await requestJson(`${this.url}/health`, {
      timeoutMs: this.timeoutMs,
      retries: 0
    });
    if (!result.ok || !result.json || !result.json.data) {
      return { available: false, redisAvailable: false, status: result.status, error: result.error };
    }
    return { available: true, redisAvailable: Boolean(result.json.data.redis && result.json.data.redis.available), status: 200 };
  }

  noteFallback() {
    this.stats.fallbacks += 1;
  }

  snapshot() {
    return { ...this.stats, lastError: this.lastError, lastSuccessAt: this.lastSuccessAt };
  }
}

module.exports = { CacheClient };
