/**
 * Budgets routes — org-scoped spend ceilings. Each `schema` block does triple duty: request
 * validation, Swagger UI, and the generated OpenAPI spec. Guarded by the identity preHandlers the
 * composition root injects: authJwt (401) then requireScope (403).
 *
 * The resource is keyed by `period`, which is its natural key (`UNIQUE (org_id, period)`), so writes
 * are a single idempotent PUT rather than a POST/PATCH pair — there is nothing to create twice.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthPreHandler } from '../../identity/index.js';
import type { BudgetsController } from '../controllers/budgets.controller.js';
import { BUDGET_PERIODS } from '../types/budgets.types.js';

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

/** Exported so a test can assert it declares every field the `Budget` wire type promises. */
export const budgetObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    id: { type: 'string' },
    // MUST be declared. Fastify's serializer drops any property the response schema omits, so
    // leaving this out silently erased the scope: every application ceiling arrived at the client
    // with no app_id, was read as org-wide, and rendered under the wrong heading.
    app_id: { type: ['string', 'null'] },
    period: { type: 'string', enum: [...BUDGET_PERIODS] },
    limit_usd: { type: 'number' },
    hard_cutoff: { type: 'boolean' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
};

const periodParams = {
  type: 'object',
  required: ['period'],
  properties: { period: { type: 'string', enum: [...BUDGET_PERIODS] } },
};

/** Same, plus the application the ceiling is scoped to. */
const appPeriodParams = {
  type: 'object',
  required: ['appId', 'period'],
  properties: {
    appId: { type: 'string', format: 'uuid' },
    period: { type: 'string', enum: [...BUDGET_PERIODS] },
  },
};

const setBudgetBody = {
  type: 'object',
  required: ['limit_usd'],
  properties: {
    limit_usd: { type: 'number', exclusiveMinimum: 0 },
    // Defaults to true: a ceiling that only warns is a report, not a budget.
    hard_cutoff: { type: 'boolean' },
  },
};

export interface BudgetsRouteGuards {
  authJwt: AuthPreHandler;
  requireScope: (...scopes: string[]) => AuthPreHandler;
  requireOrgAdmin: () => AuthPreHandler;
}

export function registerBudgetsRoutes(
  app: FastifyInstance,
  controller: BudgetsController,
  guards: BudgetsRouteGuards,
): void {
  const tags = ['budgets'];
  const read = [guards.authJwt, guards.requireScope('budgets:read')];
  // A ceiling is the org's spending limit; raising or removing one commits real money and lifting a
  // hard cutoff un-blocks traffic the org chose to stop. Members can see every budget, but only an
  // organization administrator may move one.
  const write = [guards.authJwt, guards.requireScope('budgets:write'), guards.requireOrgAdmin()];

  app.get(
    '/api/v1/budgets',
    {
      preHandler: read,
      schema: {
        tags,
        summary: 'List the organization’s spend budgets (at most one per period)',
        response: {
          200: {
            type: 'object',
            properties: {
              object: { type: 'string' },
              data: { type: 'array', items: budgetObject },
            },
          },
          401: errorObject,
          403: errorObject,
        },
      },
    },
    (request, reply) => controller.listBudgets(request, reply),
  );

  app.put(
    '/api/v1/budgets/:period',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Set (create or replace) the budget for a period — takes effect within ~1s',
        params: periodParams,
        body: setBudgetBody,
        response: { 200: budgetObject, 400: errorObject, 401: errorObject, 403: errorObject },
      },
    },
    (request, reply) => controller.setBudget(request, reply),
  );

  app.delete(
    '/api/v1/budgets/:period',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Remove the budget for a period (stops enforcing any ceiling)',
        params: periodParams,
        response: {
          204: { type: 'null' },
          401: errorObject,
          403: errorObject,
          404: errorObject,
        },
      },
    },
    (request, reply) => controller.deleteBudget(request, reply),
  );

  // ── Application-scoped ceilings ───────────────────────────────────────────────────────────────
  // Nested under the application because that is what they belong to, and because the path makes the
  // scope unmistakable — an optional query parameter on the org route would make it far too easy to
  // set an org-wide ceiling while believing you had capped one application.

  app.put(
    '/api/v1/apps/:appId/budgets/:period',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Set the budget for one application (applies in ADDITION to any org-wide ceiling)',
        params: appPeriodParams,
        body: setBudgetBody,
        response: {
          200: budgetObject,
          400: errorObject,
          401: errorObject,
          403: errorObject,
          404: errorObject,
        },
      },
    },
    (request, reply) => controller.setBudget(request, reply),
  );

  app.delete(
    '/api/v1/apps/:appId/budgets/:period',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Remove one application’s budget (the org-wide ceiling still applies)',
        params: appPeriodParams,
        response: {
          204: { type: 'null' },
          401: errorObject,
          403: errorObject,
          404: errorObject,
        },
      },
    },
    (request, reply) => controller.deleteBudget(request, reply),
  );
}
