/**
 * Traffic routes — org-scoped control plane (/api/v1/traffic). Read surface over usage_events; guarded
 * by authJwt (401) + requireScope('analytics:read') (403), reusing the analytics read scope since the
 * request feed is a read of the same usage data. Each `schema` block drives validation + OpenAPI.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthPreHandler } from '../../identity/index.js';
import type { TrafficController } from '../controllers/traffic.controller.js';

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

const trafficEvent = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    id: { type: 'string' },
    app_id: { type: 'string' },
    key_id: { type: ['string', 'null'] },
    route_id: { type: ['string', 'null'] },
    request_id: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    input_tokens: { type: 'integer' },
    output_tokens: { type: 'integer' },
    cost_usd: { type: 'number' },
    status: { type: 'string', enum: ['ok', 'error', 'rate_limited', 'budget_exceeded'] },
    latency_ms: { type: ['integer', 'null'] },
    created_at: { type: 'string' },
  },
};

const listOf = (item: object) => ({
  type: 'object',
  properties: { object: { type: 'string' }, data: { type: 'array', items: item } },
});

export interface TrafficRouteGuards {
  authJwt: AuthPreHandler;
  requireScope: (...scopes: string[]) => AuthPreHandler;
}

export function registerTrafficRoutes(
  app: FastifyInstance,
  controller: TrafficController,
  guards: TrafficRouteGuards,
): void {
  const read = [guards.authJwt, guards.requireScope('analytics:read')];
  const tags = ['traffic'];

  app.get(
    '/api/v1/traffic',
    {
      preHandler: read,
      schema: {
        tags,
        summary: 'List recent requests (most recent first)',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            status: { type: 'string', enum: ['ok', 'error', 'rate_limited', 'budget_exceeded'] },
          },
        },
        response: {
          200: listOf(trafficEvent),
          400: errorObject,
          401: errorObject,
          403: errorObject,
        },
      },
    },
    (request, reply) => controller.listRecent(request, reply),
  );

  app.get(
    '/api/v1/traffic/stream',
    {
      preHandler: read,
      schema: {
        tags,
        summary: 'Live request feed (Server-Sent Events)',
        description: 'text/event-stream of traffic.event objects for the caller’s org.',
      },
    },
    (request, reply) => controller.stream(request, reply),
  );

  app.get(
    '/api/v1/traffic/:requestId',
    {
      preHandler: read,
      schema: {
        tags,
        summary: 'Trace detail: all events for a request/trace id',
        params: {
          type: 'object',
          required: ['requestId'],
          properties: { requestId: { type: 'string' } },
        },
        response: {
          200: listOf(trafficEvent),
          401: errorObject,
          403: errorObject,
          404: errorObject,
        },
      },
    },
    (request, reply) => controller.getTrace(request, reply),
  );
}
