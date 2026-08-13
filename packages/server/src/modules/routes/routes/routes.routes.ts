/**
 * Routes routes — org-scoped control plane (/api/v1/routes). Each `schema` block does triple duty:
 * request validation, Swagger UI, and the generated OpenAPI spec. Guarded by the identity
 * preHandlers the composition root injects: authJwt (401) then requireScope (403).
 */
import type { FastifyInstance } from 'fastify';
import type { AuthPreHandler } from '../../identity/index.js';
import type { RoutesController } from '../controllers/routes.controller.js';

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

const targetInput = {
  type: 'object',
  required: ['credential_id', 'provider', 'model'],
  properties: {
    credential_id: { type: 'string', format: 'uuid' },
    provider: { type: 'string', minLength: 1 },
    model: { type: 'string', minLength: 1 },
    priority: { type: 'integer', minimum: 0 },
    weight: { type: 'integer', minimum: 1 },
  },
};

const targetObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    id: { type: 'string' },
    credential_id: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    priority: { type: 'integer' },
    weight: { type: 'integer' },
    known_model: { type: 'boolean' },
  },
};

const versionObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    id: { type: 'string' },
    version: { type: 'integer' },
    strategy: { type: 'string', enum: ['priority', 'weighted'] },
    is_active: { type: 'boolean' },
    created_at: { type: 'string' },
    targets: { type: 'array', items: targetObject },
  },
};

const routeObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    id: { type: 'string' },
    model_name: { type: 'string' },
    app_id: { type: ['string', 'null'] },
    cache_enabled: { type: 'boolean' },
    active_version_id: { type: ['string', 'null'] },
    active_version: { type: ['integer', 'null'] },
    active_strategy: { type: ['string', 'null'], enum: ['priority', 'weighted', null] },
    version_count: { type: 'integer' },
    target_count: { type: 'integer' },
    created_at: { type: 'string' },
  },
};

const routeDetailObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    id: { type: 'string' },
    model_name: { type: 'string' },
    app_id: { type: ['string', 'null'] },
    cache_enabled: { type: 'boolean' },
    active_version_id: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    versions: { type: 'array', items: versionObject },
  },
};

const routeParams = {
  type: 'object',
  required: ['routeId'],
  properties: { routeId: { type: 'string', format: 'uuid' } },
};

const listOf = (item: object) => ({
  type: 'object',
  properties: { object: { type: 'string' }, data: { type: 'array', items: item } },
});

export interface RoutesRouteGuards {
  authJwt: AuthPreHandler;
  requireScope: (...scopes: string[]) => AuthPreHandler;
}

export function registerRoutesRoutes(
  app: FastifyInstance,
  controller: RoutesController,
  guards: RoutesRouteGuards,
): void {
  const read = [guards.authJwt, guards.requireScope('routes:read')];
  const write = [guards.authJwt, guards.requireScope('routes:write')];
  const tags = ['routes'];

  app.get(
    '/api/v1/routes',
    {
      preHandler: read,
      schema: {
        tags,
        summary: 'List routes with their active-version summary',
        response: { 200: listOf(routeObject), 401: errorObject, 403: errorObject },
      },
    },
    (request, reply) => controller.listRoutes(request, reply),
  );

  app.get(
    '/api/v1/routes/:routeId',
    {
      preHandler: read,
      schema: {
        tags,
        summary: 'Retrieve a route with all versions and targets',
        params: routeParams,
        response: { 200: routeDetailObject, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.getRoute(request, reply),
  );

  app.post(
    '/api/v1/routes',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Create a route (optionally with an initial active version)',
        body: {
          type: 'object',
          required: ['model_name'],
          properties: {
            model_name: { type: 'string', minLength: 1, maxLength: 200 },
            // Omit (or null) for the org-wide route every application falls back to; supply an
            // application id to give that one application its own route for this model name.
            app_id: { type: ['string', 'null'], format: 'uuid' },
            strategy: { type: 'string', enum: ['priority', 'weighted'] },
            cache_enabled: { type: 'boolean' },
            targets: { type: 'array', items: targetInput },
          },
        },
        response: {
          201: routeDetailObject,
          400: errorObject,
          401: errorObject,
          403: errorObject,
          409: errorObject,
        },
      },
    },
    (request, reply) => controller.createRoute(request, reply),
  );

  app.post(
    '/api/v1/routes/:routeId/versions',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Add a new version to a route (not activated automatically)',
        params: routeParams,
        body: {
          type: 'object',
          required: ['targets'],
          properties: {
            strategy: { type: 'string', enum: ['priority', 'weighted'] },
            targets: { type: 'array', minItems: 1, items: targetInput },
          },
        },
        response: {
          201: routeDetailObject,
          400: errorObject,
          401: errorObject,
          403: errorObject,
          404: errorObject,
        },
      },
    },
    (request, reply) => controller.addVersion(request, reply),
  );

  app.post(
    '/api/v1/routes/:routeId/activate',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Activate a version (rollback = activate an older one)',
        params: routeParams,
        body: {
          type: 'object',
          required: ['version_id'],
          properties: { version_id: { type: 'string', format: 'uuid' } },
        },
        response: { 200: routeDetailObject, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.activateVersion(request, reply),
  );

  app.patch(
    '/api/v1/routes/:routeId/cache',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Toggle exact-cache for a route',
        params: routeParams,
        body: {
          type: 'object',
          required: ['cache_enabled'],
          properties: { cache_enabled: { type: 'boolean' } },
        },
        response: { 200: routeDetailObject, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.setCache(request, reply),
  );

  app.delete(
    '/api/v1/routes/:routeId',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Delete a route and all its versions',
        params: routeParams,
        response: { 204: { type: 'null' }, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.deleteRoute(request, reply),
  );
}
