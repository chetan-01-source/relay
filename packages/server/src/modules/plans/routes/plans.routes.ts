/**
 * Plans routes. Each `schema` block does triple duty: request validation, Swagger UI, and the
 * generated OpenAPI document the console's types and `@relay/sdk` are both generated from.
 *
 * Scope choices, deliberately reusing the existing vocabulary rather than minting new scopes (a new
 * scope means re-running the Logto bootstrap, and every already-issued token would lack it):
 *   • reading your own plan            → `relay:read`, which every role carries
 *   • changing it                      → `budgets:write` + org admin, because a plan change moves
 *                                        money exactly like a budget change does
 *   • assigning one to any org         → `platform:admin`
 *
 * `GET /api/v1/plans` is UNAUTHENTICATED on purpose: a price list is public information, and the
 * marketing page renders it without a session.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthPreHandler } from '../../identity/index.js';
import { LIMIT_KEYS } from '../lib/limits.js';
import type { PlansController } from '../controllers/plans.controller.js';

const errorObject = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        type: { type: 'string' },
        code: { type: 'string' },
        param: { type: ['string', 'null'] },
      },
    },
  },
};

/** A limit value is a number, a boolean, or null (unlimited) — all three must be declared, or
 * Fastify's serializer silently drops the ones it does not expect. */
const limitValue = { type: ['number', 'boolean', 'null'] };

const limitsObject = {
  type: 'object',
  properties: Object.fromEntries(
    LIMIT_KEYS.map((key) => [
      key,
      {
        type: 'object',
        properties: {
          value: limitValue,
          source: { type: 'string', enum: ['plan', 'override', 'org_feature', 'default'] },
          used: { type: 'number' },
        },
      },
    ]),
  ),
};

const planObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    code: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    tier: { type: 'number' },
    price_monthly_usd: { type: ['number', 'null'] },
    price_yearly_usd: { type: ['number', 'null'] },
    limits: {
      type: 'object',
      properties: Object.fromEntries(LIMIT_KEYS.map((key) => [key, limitValue])),
    },
  },
};

const effectivePlanObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    plan: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        name: { type: 'string' },
        tier: { type: 'number' },
      },
    },
    status: { type: 'string', enum: ['trialing', 'active', 'past_due', 'canceled'] },
    lapsed: { type: 'boolean' },
    trial_ends_at: { type: ['string', 'null'] },
    current_period_end: { type: ['string', 'null'] },
    limits: limitsObject,
  },
};

const subscriptionObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    org_id: { type: 'string' },
    plan_code: { type: 'string' },
    status: { type: 'string', enum: ['trialing', 'active', 'past_due', 'canceled'] },
    trial_ends_at: { type: ['string', 'null'] },
    grace_until: { type: ['string', 'null'] },
    current_period_end: { type: ['string', 'null'] },
    overrides: {
      type: 'object',
      properties: Object.fromEntries(LIMIT_KEYS.map((key) => [key, limitValue])),
    },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
};

export interface PlansRouteGuards {
  authJwt: AuthPreHandler;
  requireScope: (...scopes: string[]) => AuthPreHandler;
  requireOrgAdmin: () => AuthPreHandler;
}

export function registerPlansRoutes(
  app: FastifyInstance,
  controller: PlansController,
  guards: PlansRouteGuards,
): void {
  const tags = ['plans'];

  app.get(
    '/api/v1/plans',
    {
      schema: {
        tags,
        summary: 'The purchasable plan catalog (public; empty in the self-hosted edition)',
        response: {
          200: {
            type: 'object',
            properties: { object: { type: 'string' }, data: { type: 'array', items: planObject } },
          },
        },
      },
    },
    (request, reply) => controller.listCatalog(request, reply),
  );

  app.get(
    '/api/v1/plan',
    {
      preHandler: [guards.authJwt, guards.requireScope('relay:read')],
      schema: {
        tags,
        summary: 'This organization’s effective limits, with provenance and current usage',
        response: { 200: effectivePlanObject, 401: errorObject, 403: errorObject },
      },
    },
    (request, reply) => controller.getPlan(request, reply),
  );

  app.post(
    '/api/v1/plan/change',
    {
      preHandler: [guards.authJwt, guards.requireScope('budgets:write'), guards.requireOrgAdmin()],
      schema: {
        tags,
        summary: 'Move this organization to another public plan — takes effect within ~1s',
        body: {
          type: 'object',
          required: ['plan_code'],
          properties: { plan_code: { type: 'string' } },
        },
        response: {
          200: subscriptionObject,
          401: errorObject,
          403: errorObject,
          404: errorObject,
        },
      },
    },
    (request, reply) => controller.changePlan(request, reply),
  );

  // ── Platform control plane ────────────────────────────────────────────────────────────────────
  const platform = [guards.authJwt, guards.requireScope('platform:admin')];
  const orgParams = {
    type: 'object',
    required: ['orgId'],
    properties: { orgId: { type: 'string', format: 'uuid' } },
  };

  app.get(
    '/api/v1/platform/orgs/:orgId/subscription',
    {
      preHandler: platform,
      schema: {
        tags,
        summary: 'Read any organization’s subscription',
        params: orgParams,
        response: { 200: subscriptionObject, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.getSubscription(request, reply),
  );

  app.put(
    '/api/v1/platform/orgs/:orgId/subscription',
    {
      preHandler: platform,
      schema: {
        tags,
        summary: 'Assign a plan, set per-contract overrides, or extend a trial',
        params: orgParams,
        body: {
          type: 'object',
          required: ['plan_code'],
          properties: {
            plan_code: { type: 'string' },
            status: { type: 'string', enum: ['trialing', 'active', 'past_due', 'canceled'] },
            trial_ends_at: { type: ['string', 'null'] },
            grace_until: { type: ['string', 'null'] },
            current_period_end: { type: ['string', 'null'] },
            // Free-form by JSON Schema, filtered to the declared key set in the controller — a typo
            // in an overrides blob must not become a production entitlement.
            overrides: { type: 'object', additionalProperties: limitValue },
          },
        },
        response: { 200: subscriptionObject, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.setSubscription(request, reply),
  );
}
