'use strict';

const { sign, verify, NonceStore, HEADERS } = require('../../shared/hmac');

const SECRET = 'test-secret-value-that-is-long-enough';

function signed(overrides = {}) {
  return sign({
    secret: SECRET,
    client: 'api-gateway',
    method: 'GET',
    path: '/api/books?limit=5',
    body: '',
    ...overrides
  });
}

describe('HMAC request signing', () => {
  test('accepts a valid signature once', () => {
    const nonceStore = new NonceStore();
    const headers = signed();
    const result = verify({
      secret: SECRET,
      method: 'GET',
      path: '/api/books?limit=5',
      body: '',
      headers,
      nonceStore
    });
    expect(result).toEqual({ ok: true, client: 'api-gateway' });
  });

  test('rejects a replayed nonce', () => {
    const nonceStore = new NonceStore();
    const headers = signed();
    const options = {
      secret: SECRET,
      method: 'GET',
      path: '/api/books?limit=5',
      body: '',
      headers,
      nonceStore
    };
    expect(verify(options).ok).toBe(true);
    expect(verify(options)).toEqual({ ok: false, reason: 'replayed_nonce' });
  });

  test('rejects a tampered path', () => {
    const headers = signed();
    const result = verify({
      secret: SECRET,
      method: 'GET',
      path: '/api/books/999',
      body: '',
      headers
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  test('rejects a tampered body', () => {
    const headers = signed({ method: 'POST', path: '/api/borrows', body: '{"bookId":1}' });
    const result = verify({
      secret: SECRET,
      method: 'POST',
      path: '/api/borrows',
      body: '{"bookId":2}',
      headers
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  test('rejects a client mismatch', () => {
    const headers = signed();
    const result = verify({
      secret: SECRET,
      client: 'borrow-service',
      method: 'GET',
      path: '/api/books?limit=5',
      body: '',
      headers
    });
    expect(result).toEqual({ ok: false, reason: 'client_mismatch' });
  });

  test('rejects an old timestamp', () => {
    const headers = signed({ timestamp: Date.now() - 600000 });
    const result = verify({
      secret: SECRET,
      method: 'GET',
      path: '/api/books?limit=5',
      body: '',
      headers,
      maxSkewMs: 1000
    });
    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_range' });
  });

  test('rejects missing headers', () => {
    const result = verify({
      secret: SECRET,
      method: 'GET',
      path: '/api/books',
      body: '',
      headers: {}
    });
    expect(result).toEqual({ ok: false, reason: 'missing_headers' });
  });

  test('signs with the documented header names', () => {
    const headers = signed();
    expect(headers[HEADERS.client]).toBe('api-gateway');
    expect(headers[HEADERS.timestamp]).toBeDefined();
    expect(headers[HEADERS.nonce]).toBeDefined();
    expect(headers[HEADERS.signature]).toHaveLength(64);
  });
});
