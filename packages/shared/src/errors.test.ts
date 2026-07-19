import { describe, it, expect } from 'vitest';
import { RelayError, toErrorEnvelope, ERROR_CATALOG, isRelayError } from './errors.js';

describe('RelayError', () => {
  it('derives status + type + default message from the catalog', () => {
    const e = new RelayError('invalid_api_key');
    expect(e.status).toBe(401);
    expect(e.type).toBe('authentication_error');
    expect(e.message).toBe(ERROR_CATALOG.invalid_api_key.message);
    expect(isRelayError(e)).toBe(true);
  });

  it('allows a custom message and a status override (upstream passthrough)', () => {
    const e = new RelayError('upstream_error', { status: 429, message: 'provider says slow down' });
    expect(e.status).toBe(429); // overridden
    expect(e.type).toBe('api_error'); // still from catalog
    expect(e.message).toBe('provider says slow down');
  });

  it('serializes to the OpenAI-compatible envelope', () => {
    const { status, body } = new RelayError('model_not_found', {
      message: "no 'x'",
      param: 'model',
    }).toResponse();
    expect(status).toBe(404);
    expect(body).toEqual({
      error: {
        message: "no 'x'",
        type: 'not_found_error',
        code: 'model_not_found',
        param: 'model',
      },
    });
  });
});

describe('toErrorEnvelope', () => {
  it('passes a RelayError through', () => {
    expect(toErrorEnvelope(new RelayError('rate_limited')).status).toBe(429);
  });

  it('maps a Fastify validation error to invalid_request (400)', () => {
    const res = toErrorEnvelope({ validation: [{ message: 'x' }], message: 'body/model required' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(res.body.error.message).toBe('body/model required');
  });

  it('maps an unknown throw to a safe internal_error (500), leaking nothing', () => {
    const res = toErrorEnvelope(new Error('secret db dsn leaked here'));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
    expect(res.body.error.message).not.toContain('secret');
  });

  it('exposes the control-plane codes with their RESTful statuses', () => {
    expect(new RelayError('conflict').status).toBe(409);
    expect(new RelayError('conflict').type).toBe('invalid_request_error');
    expect(new RelayError('service_unavailable').status).toBe(503);
    expect(new RelayError('service_unavailable').type).toBe('api_error');
  });

  it('every catalog entry has a status, type and message', () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(entry.status, code).toBeGreaterThanOrEqual(400);
      expect(entry.type, code).toBeTruthy();
      expect(entry.message, code).toBeTruthy();
    }
  });
});
