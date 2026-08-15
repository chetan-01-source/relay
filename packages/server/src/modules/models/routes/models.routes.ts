/**
 * Models routes — HTTP surface only. OpenAI-compatible model discovery (PRD §2: /v1/models).
 * The `schema` blocks feed @fastify/swagger (docs) and give request validation for free.
 */
import { PROVIDER_IDS } from 'relay-shared';
import type { AuthPreHandler } from '../../identity/index.js';
import type { FastifyInstance } from 'fastify';
import type { ModelsController } from '../controllers/models.controller.js';

const modelObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string', enum: ['model'] },
    created: { type: 'integer' },
    owned_by: { type: 'string' },
  },
};

// Full OpenAI-compatible error envelope (shared/errors.ts). Must list every field, or Fastify's
// response serialization strips the ones the schema omits (e.g. type/param).
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

export interface ModelsRouteGuards {
  authJwt: AuthPreHandler;
  requireScope: (...scopes: string[]) => AuthPreHandler;
}

const catalogModelObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    capabilities: { type: 'object', additionalProperties: true },
  },
};

export function registerModelsRoutes(
  app: FastifyInstance,
  controller: ModelsController,
  guards?: ModelsRouteGuards,
): void {
  app.get(
    '/v1/models',
    {
      schema: {
        tags: ['models'],
        summary: 'List available models',
        response: {
          200: {
            type: 'object',
            properties: { object: { type: 'string' }, data: { type: 'array', items: modelObject } },
          },
        },
      },
    },
    (request, reply) => controller.list(request, reply),
  );

  app.get(
    '/v1/models/:model',
    {
      schema: {
        tags: ['models'],
        summary: 'Retrieve a model by id',
        params: {
          type: 'object',
          required: ['model'],
          properties: { model: { type: 'string' } },
        },
        response: { 200: modelObject, 404: errorObject },
      },
    },
    (request, reply) => controller.getOne(request, reply),
  );

  // Control plane, not the OpenAI surface. `/v1/models` answers "what may this KEY call" — the route
  // aliases. This answers "what models exist upstream", which is what the console needs to build a
  // route target or pick a playground model, and is a different question with a different audience.
  if (!guards) return;
  app.get(
    '/api/v1/catalog/models',
    {
      preHandler: [guards.authJwt, guards.requireScope('routes:read')],
      schema: {
        tags: ['catalog'],
        summary: 'Search the upstream model catalog',
        querystring: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: PROVIDER_IDS },
            q: { type: 'string', maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              object: { type: 'string' },
              data: { type: 'array', items: catalogModelObject },
              counts: { type: 'object', additionalProperties: { type: 'integer' } },
            },
          },
        },
      },
    },
    (request, reply) => controller.searchCatalog(request, reply),
  );
}
