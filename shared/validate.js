'use strict';

const { ApiError } = require('./errors');

function stringField(value, name, { min = 1, max = 255, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, 'VALIDATION_ERROR', `${name} is required`);
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', `${name} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min) throw new ApiError(400, 'VALIDATION_ERROR', `${name} must be at least ${min} characters`);
  if (trimmed.length > max) throw new ApiError(400, 'VALIDATION_ERROR', `${name} must be at most ${max} characters`);
  return trimmed;
}

function intField(value, name, { min = 1, max = 2147483647, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, 'VALIDATION_ERROR', `${name} is required`);
    return undefined;
  }
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number)) throw new ApiError(400, 'VALIDATION_ERROR', `${name} must be an integer`);
  if (number < min || number > max) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${name} must be between ${min} and ${max}`);
  }
  return number;
}

function boolField(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new ApiError(400, 'VALIDATION_ERROR', `${name} must be a boolean`);
}

function emailField(value, name = 'email') {
  const email = stringField(value, name, { min: 3, max: 254 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${name} must be a valid email address`);
  }
  return email.toLowerCase();
}

function intQuery(value, name, { fallback, min = 0, max = 1000 } = {}) {
  if (value === undefined || value === '') return fallback;
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function enumField(value, name, allowed) {
  if (!allowed.includes(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

module.exports = {
  stringField,
  intField,
  boolField,
  emailField,
  intQuery,
  enumField
};
