import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { budgetObject } from '../routes/budgets.routes.js';
import type { Budget } from '../types/budgets.types.js';

/**
 * Fastify serializes responses through the route's schema and DROPS any property the schema does not
 * declare. That makes an omission silent: the handler returns the field, the client never sees it,
 * and nothing fails.
 *
 * It bit exactly once, and expensively — `app_id` was missing here, so every application-scoped
 * budget reached the console with no scope, was read as org-wide, rendered under the wrong heading,
 * and could not be deleted from where it appeared. This test is the guard: the schema has to declare
 * every key the wire type promises.
 */
describe('budget response schema', () => {
  it('declares every field of the Budget wire type', () => {
    // Listing the keys explicitly (rather than deriving them) is the point — adding a field to
    // `Budget` without adding it here should fail, and a derived list could never catch that.
    const expected: Record<keyof Budget, true> = {
      object: true,
      id: true,
      app_id: true,
      period: true,
      limit_usd: true,
      hard_cutoff: true,
      created_at: true,
      updated_at: true,
    };
    expect(Object.keys(budgetObject.properties).sort()).toEqual(Object.keys(expected).sort());
  });

  it('allows app_id to be null, which is how an org-wide ceiling is expressed', () => {
    // A bare `{ type: 'string' }` would serialize null away and reintroduce the same bug.
    expect(budgetObject.properties.app_id.type).toEqual(['string', 'null']);
  });

  // The declaration test above would still pass if Fastify serialized it differently, so this drives
  // the real serializer and reads the bytes a client would actually receive.
  it('actually emits app_id through Fastify — both scopes survive serialization', async () => {
    const app = Fastify({ logger: false });
    app.get('/b', { schema: { response: { 200: budgetObject } } }, (_req, reply) =>
      reply.send({
        object: 'budget',
        id: 'b1',
        app_id: 'a6b6835b-1d0a-4c13-b539-eaaca3494799',
        period: 'monthly',
        limit_usd: 0.0001,
        hard_cutoff: true,
        created_at: 'now',
        updated_at: 'now',
      }),
    );
    app.get('/org', { schema: { response: { 200: budgetObject } } }, (_req, reply) =>
      reply.send({
        object: 'budget',
        id: 'b2',
        app_id: null,
        period: 'monthly',
        limit_usd: 5,
        hard_cutoff: true,
        created_at: 'now',
        updated_at: 'now',
      }),
    );

    const scoped = (await app.inject({ method: 'GET', url: '/b' })).json();
    expect(scoped.app_id).toBe('a6b6835b-1d0a-4c13-b539-eaaca3494799');

    const orgWide = (await app.inject({ method: 'GET', url: '/org' })).json();
    expect(orgWide).toHaveProperty('app_id');
    expect(orgWide.app_id).toBeNull();

    await app.close();
  });
});
