'use strict';

const crypto = require('node:crypto');
const { fail } = require('./respond');

const SCOPE_HEADERS = {
  admin: 'x-admin-token',
  service: 'x-service-token',
  read: 'x-read-token'
};

function safeEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (provided.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return undefined;
}

/**
 * Determine the supplied token scope without revealing which comparison failed.
 * secrets = { admin, service, read }
 */
function identifyScope(req, secrets) {
  for (const [scope, header] of Object.entries(SCOPE_HEADERS)) {
    const token = req.get(header);
    if (token && secrets[scope] && safeEqual(token, secrets[scope])) {
      return scope;
    }
  }
  const bearer = bearerToken(req);
  if (bearer) {
    for (const scope of ['admin', 'service', 'read']) {
      if (secrets[scope] && safeEqual(bearer, secrets[scope])) return scope;
    }
  }
  return null;
}

/**
 * Express middleware factory. allowed = ['admin'] etc.
 */
function requireScope(allowed, secrets, { onFailure } = {}) {
  return (req, res, next) => {
    const scope = identifyScope(req, secrets);
    if (!scope || !allowed.includes(scope)) {
      if (typeof onFailure === 'function') {
        onFailure({ scope, path: req.originalUrl, method: req.method, requestId: req.id });
      }
      return fail(res, 401, 'UNAUTHORIZED', 'A valid token with the required scope is needed');
    }
    req.auth = { scope };
    return next();
  };
}

function requireApiKey(expected, header = 'x-api-key', { onFailure } = {}) {
  return (req, res, next) => {
    const token = req.get(header) || bearerToken(req);
    if (!safeEqual(token, expected)) {
      if (typeof onFailure === 'function') {
        onFailure({ path: req.originalUrl, method: req.method, requestId: req.id });
      }
      return fail(res, 401, 'UNAUTHORIZED', 'A valid API key is required');
    }
    return next();
  };
}

module.exports = { requireScope, requireApiKey, identifyScope, safeEqual, bearerToken };
