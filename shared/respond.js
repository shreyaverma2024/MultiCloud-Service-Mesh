'use strict';

/** Consistent JSON response envelope used by every backend component. */

function ok(res, data, meta, status = 200) {
  const body = { data };
  if (meta !== undefined) body.meta = meta;
  return res.status(status).json(body);
}

function fail(res, status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return res.status(status).json({ error });
}

module.exports = { ok, fail };
