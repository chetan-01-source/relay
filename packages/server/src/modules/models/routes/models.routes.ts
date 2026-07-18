/**
 * Models routes — HTTP surface only. OpenAI-compatible model discovery (PRD §2: /v1/models).
 * The `schema` blocks feed @fastify/swagger (docs) and give request validation for free.
 */
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

export function registerModelsRoutes(app: FastifyInstance, controller: ModelsController): void {
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
}
