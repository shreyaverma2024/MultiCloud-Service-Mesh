'use strict';

const crypto = require('node:crypto');

/**
 * Application-level authentication for cross-cloud requests.
 *
 * Render terminates public HTTPS at its edge, so ordinary Render HTTPS does
 * NOT provide end-to-end sidecar mTLS. We therefore sign the request itself
 * with HMAC-SHA256. Each direction uses a different secret:
 *   AWS -> Render : AWS_TO_RENDER_HMAC_SECRET
 *   Render -> AWS : RENDER_TO_AWS_HMAC_SECRET
 */

const HEADERS = {
  client: 'x-mesh-client',
  timestamp: 'x-mesh-timestamp',
  nonce: 'x-mesh-nonce',
  signature: 'x-mesh-signature'
};

function bodyToBuffer(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  // express.raw()/express.json() leave req.body as an empty object for
  // bodyless requests such as GET. Treat that the same as "no body" so the
  // canonical string matches what the signer produced.
  if (typeof body === 'object' && Object.keys(body).length === 0) return Buffer.alloc(0);
  return Buffer.from(JSON.stringify(body), 'utf8');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function canonicalString({ client, timestamp, nonce, method, path, body }) {
  return [
    client,
    String(timestamp),
    nonce,
    String(method).toUpperCase(),
    path,
    sha256(bodyToBuffer(body))
  ].join('\n');
}

function sign({ secret, client, method, path, body, timestamp = Date.now(), nonce }) {
  if (!secret) throw new Error('HMAC secret is required');
  if (!client) throw new Error('HMAC client id is required');
  const usedNonce = nonce || crypto.randomUUID();
  const canonical = canonicalString({ client, timestamp, nonce: usedNonce, method, path, body });
  const signature = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  return {
    [HEADERS.client]: client,
    [HEADERS.timestamp]: String(timestamp),
    [HEADERS.nonce]: usedNonce,
    [HEADERS.signature]: signature
  };
}

class NonceStore {
  constructor(ttlMs = 300000, maxEntries = 10000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  checkAndAdd(nonce) {
    const now = Date.now();
    this.cleanup(now);
    if (this.entries.has(nonce)) return false;
    this.entries.set(nonce, now + this.ttlMs);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    return true;
  }

  cleanup(now = Date.now()) {
    for (const [nonce, expiresAt] of this.entries.entries()) {
      if (expiresAt <= now) this.entries.delete(nonce);
    }
  }
}

function verify({
  secret,
  client,
  method,
  path,
  body,
  headers,
  nonceStore,
  maxSkewMs = 300000,
  now = Date.now()
}) {
  if (!secret) return { ok: false, reason: 'secret_not_configured' };
  const suppliedClient = headers[HEADERS.client] || headers[HEADERS.client.toLowerCase()];
  const timestamp = headers[HEADERS.timestamp] || headers[HEADERS.timestamp.toLowerCase()];
  const nonce = headers[HEADERS.nonce] || headers[HEADERS.nonce.toLowerCase()];
  const signature = headers[HEADERS.signature] || headers[HEADERS.signature.toLowerCase()];

  if (!suppliedClient || !timestamp || !nonce || !signature) {
    return { ok: false, reason: 'missing_headers' };
  }
  if (client && suppliedClient !== client) {
    return { ok: false, reason: 'client_mismatch' };
  }
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) return { ok: false, reason: 'invalid_timestamp' };
  if (Math.abs(now - timestampNumber) > maxSkewMs) return { ok: false, reason: 'timestamp_out_of_range' };

  if (nonceStore && !nonceStore.checkAndAdd(nonce)) {
    return { ok: false, reason: 'replayed_nonce' };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(canonicalString({ client: suppliedClient, timestamp: timestampNumber, nonce, method, path, body }))
    .digest('hex');

  const supplied = Buffer.from(String(signature), 'utf8');
  const computed = Buffer.from(expected, 'utf8');
  if (supplied.length !== computed.length) return { ok: false, reason: 'invalid_signature' };
  if (!crypto.timingSafeEqual(supplied, computed)) return { ok: false, reason: 'invalid_signature' };

  return { ok: true, client: suppliedClient };
}

function verifyExpressRequest(req, { secret, client, nonceStore, maxSkewMs }) {
  return verify({
    secret,
    client,
    method: req.method,
    path: req.originalUrl,
    body: req.body,
    headers: req.headers,
    nonceStore,
    maxSkewMs
  });
}

module.exports = { HEADERS, sign, verify, verifyExpressRequest, NonceStore, bodyToBuffer };
