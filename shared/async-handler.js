'use strict';

/** Wrap async Express handlers so rejected promises reach the error handler. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncHandler };
