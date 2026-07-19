/**
 * Providers routes — org-scoped control plane (/api/v1/providers). Each `schema` block does triple
 * duty: request validation, Swagger UI, and the generated OpenAPI spec. Guarded by the identity
 * preHandlers the composition root injects: authJwt (401) then requireScope (403). The response
 * schema intentionally lists only metadata — a credential's secret is never part of any response.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthPreHandler } from '../../identity/index.js';
import type { ProvidersController } from '../controllers/providers.controller.js';

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

const credentialObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    id: { type: 'string' },
    name: { type: 'string' },
    provider: { type: 'string', enum: ['openai', 'anthropic', 'openai_compat'] },
    last4: { type: 'string' },
    base_url: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['active', 'disabled'] },
    health_score: { type: 'number' },
    created_at: { type: 'string' },
  },
};

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
};

export interface ProvidersRouteGuards {
  authJwt: AuthPreHandler;
  requireScope: (...scopes: string[]) => AuthPreHandler;
}

export function registerProvidersRoutes(
  app: FastifyInstance,
  controller: ProvidersController,
  guards: ProvidersRouteGuards,
): void {
  const read = [guards.authJwt, guards.requireScope('providers:read')];
  const write = [guards.authJwt, guards.requireScope('providers:write')];
  const tags = ['providers'];

  app.post(
    '/api/v1/providers',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Store a provider credential (sealed on write, never returned)',
        body: {
          type: 'object',
          required: ['name', 'provider', 'apiKey'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            provider: { type: 'string', enum: ['openai', 'anthropic', 'openai_compat'] },
            apiKey: { type: 'string', minLength: 1 },
            baseUrl: { type: 'string', format: 'uri' },
          },
        },
        response: { 201: credentialObject, 400: errorObject, 401: errorObject, 403: errorObject },
      },
    },
    (request, reply) => controller.create(request, reply),
  );

  app.get(
    '/api/v1/providers',
    {
      preHandler: read,
      schema: {
        tags,
        summary: 'List provider credentials (metadata only)',
        response: {
          200: {
            type: 'object',
            properties: {
              object: { type: 'string' },
              data: { type: 'array', items: credentialObject },
            },
          },
          401: errorObject,
          403: errorObject,
        },
      },
    },
    (request, reply) => controller.list(request, reply),
  );

  app.get(
    '/api/v1/providers/:id',
    {
      preHandler: read,
      schema: {
        tags,
        summary: 'Retrieve a provider credential (metadata only)',
        params: idParams,
        response: { 200: credentialObject, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.getOne(request, reply),
  );

  app.delete(
    '/api/v1/providers/:id',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Delete a provider credential',
        params: idParams,
        response: { 204: { type: 'null' }, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.remove(request, reply),
  );
}
