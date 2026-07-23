/**
 * Analytics routes — control-plane usage/spend surface. Each `schema` block does triple duty:
 * request validation, Swagger UI, and the generated OpenAPI spec. Guarded by the identity
 * preHandlers the composition root injects: authJwt (401) then requireScope (403). The org-scoped
 * route requires `analytics:read`; the cross-org summary requires `platform:admin`.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthPreHandler } from '../../identity/index.js';
import type { AnalyticsController } from '../controllers/analytics.controller.js';

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

const usageBucket = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    requests: { type: 'integer' },
    input_tokens: { type: 'integer' },
    output_tokens: { type: 'integer' },
    cost_usd: { type: 'number' },
  },
};

const usageSummary = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    group_by: { type: 'string' },
    data: { type: 'array', items: usageBucket },
  },
};

// Shared querystring schema. `format=csv` returns text/csv (the CSV body bypasses this JSON schema —
// Fastify only serializes object payloads through the response schema, not string payloads).
const usageQuerystring = {
  type: 'object',
  properties: {
    group_by: { type: 'string', enum: ['app', 'route', 'model', 'day'] },
    format: { type: 'string', enum: ['json', 'csv'] },
    from: { type: 'string' },
    to: { type: 'string' },
  },
};

export interface AnalyticsRouteGuards {
  authJwt: AuthPreHandler;
  requireScope: (...scopes: string[]) => AuthPreHandler;
}

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  controller: AnalyticsController,
  guards: AnalyticsRouteGuards,
): void {
  const tags = ['analytics'];

  app.get(
    '/api/v1/analytics/usage',
    {
      preHandler: [guards.authJwt, guards.requireScope('analytics:read')],
      schema: {
        tags,
        summary: 'Grouped usage/spend for the caller’s organization (reads hourly rollups)',
        querystring: usageQuerystring,
        response: { 200: usageSummary, 400: errorObject, 401: errorObject, 403: errorObject },
      },
    },
    (request, reply) => controller.getUsage(request, reply),
  );

  app.get(
    '/api/v1/platform/analytics/usage',
    {
      preHandler: [guards.authJwt, guards.requireScope('platform:admin')],
      schema: {
        tags,
        summary: 'Cross-org spend summary grouped by org (platform-admin only)',
        querystring: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['json', 'csv'] },
            from: { type: 'string' },
            to: { type: 'string' },
          },
        },
        response: { 200: usageSummary, 400: errorObject, 401: errorObject, 403: errorObject },
      },
    },
    (request, reply) => controller.getUsageAllOrgs(request, reply),
  );
}
