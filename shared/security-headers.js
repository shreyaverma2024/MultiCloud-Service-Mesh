'use strict';

/** Minimal security headers without an extra dependency. */
function securityHeaders(req, res, next) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

module.exports = { securityHeaders };
