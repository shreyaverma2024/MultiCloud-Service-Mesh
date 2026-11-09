'use strict';

const { validate, errors } = require('../../shared');

describe('validation helpers', () => {
  test('accepts valid integers and rejects out-of-range values', () => {
    expect(validate.intField('7', 'bookId')).toBe(7);
    expect(() => validate.intField('0', 'bookId', { min: 1 })).toThrow(errors.ApiError);
    expect(() => validate.intField('abc', 'bookId')).toThrow('bookId must be an integer');
  });

  test('trims strings and enforces lengths', () => {
    expect(validate.stringField('  hello  ', 'name')).toBe('hello');
    expect(() => validate.stringField('', 'name')).toThrow('name is required');
    expect(() => validate.stringField('ab', 'name', { min: 3 })).toThrow('at least 3');
  });

  test('validates email addresses', () => {
    expect(validate.emailField('Person@Example.COM')).toBe('person@example.com');
    expect(() => validate.emailField('not-an-email')).toThrow('valid email');
  });

  test('parses optional query integers', () => {
    expect(validate.intQuery(undefined, 'limit', { fallback: 20 })).toBe(20);
    expect(validate.intQuery('5', 'limit', { min: 1, max: 10 })).toBe(5);
    expect(() => validate.intQuery('99', 'limit', { min: 1, max: 10 })).toThrow('between 1 and 10');
  });
});
