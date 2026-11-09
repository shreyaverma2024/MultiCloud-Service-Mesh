'use strict';

const { fail } = require('./respond');

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function notFoundHandler(req, res) {
  return fail(res, 404, 'NOT_FOUND', `No route for ${req.method} ${req.originalUrl}`);
}

// Express identifies error handlers by their four arguments.
// eslint-disable-next-line no-unused-vars
function errorHandler(logger) {
  return (err, req, res, next) => {
    const status = err.status || 500;
    const code = err.code || (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR');
    if (status >= 500 && logger) {
      logger.error('request_failed', {
        requestId: req.id,
        method: req.method,
        path: req.originalUrl,
        message: err.message,
        stack: process.env.NODE_ENV === 'production' ? undefined : err.stack
      });
    }
    if (res.headersSent) return next(err);
    return fail(res, status, code, err.message || 'Unexpected error', err.details);
  };
}

module.exports = { ApiError, notFoundHandler, errorHandler };
