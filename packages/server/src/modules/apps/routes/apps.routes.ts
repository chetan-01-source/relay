/**
 * Apps routes — org-scoped control plane (/api/v1/apps, /api/v1/keys). Each `schema` block does
 * triple duty: request validation, Swagger UI, and the generated OpenAPI spec. Guarded by the
 * identity preHandlers the composition root injects: authJwt (401) then requireScope (403).
 */
import type { FastifyInstance } from 'fastify';
import type { AuthPreHandler } from '../../identity/index.js';
import type { AppsController } from '../controllers/apps.controller.js';

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

const applicationObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    created_at: { type: 'string' },
  },
};

const KEY_PROPS = {
  object: { type: 'string' },
  id: { type: 'string' },
  app_id: { type: 'string' },
  key_id: { type: ['string', 'null'] },
  name: { type: ['string', 'null'] },
  last4: { type: 'string' },
  environment: { type: 'string', enum: ['live', 'test'] },
  status: { type: 'string', enum: ['active', 'revoked'] },
  successor_id: { type: ['string', 'null'] },
  grace_until: { type: ['string', 'null'] },
  created_at: { type: 'string' },
  revoked_at: { type: ['string', 'null'] },
};
const virtualKeyObject = { type: 'object', properties: KEY_PROPS };
// The issue/rotate response additionally carries the one-time plaintext `key`.
const issuedKeyObject = {
  type: 'object',
  properties: { ...KEY_PROPS, key: { type: 'string' } },
};

const appParams = {
  type: 'object',
  required: ['appId'],
  properties: { appId: { type: 'string', format: 'uuid' } },
};
const keyParams = {
  type: 'object',
  required: ['keyId'],
  properties: { keyId: { type: 'string', format: 'uuid' } },
};

const listOf = (item: object) => ({
  type: 'object',
  properties: { object: { type: 'string' }, data: { type: 'array', items: item } },
});

export interface AppsRouteGuards {
  authJwt: AuthPreHandler;
  requireScope: (...scopes: string[]) => AuthPreHandler;
}

export function registerAppsRoutes(
  app: FastifyInstance,
  controller: AppsController,
  guards: AppsRouteGuards,
): void {
  const read = [guards.authJwt, guards.requireScope('apps:read')];
  const write = [guards.authJwt, guards.requireScope('apps:write')];
  const tags = ['apps'];

  app.post(
    '/api/v1/apps',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Create an application',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            description: { type: 'string', maxLength: 1000 },
          },
        },
        response: { 201: applicationObject, 401: errorObject, 403: errorObject },
      },
    },
    (request, reply) => controller.createApp(request, reply),
  );

  app.get(
    '/api/v1/apps',
    {
      preHandler: read,
      schema: {
        tags,
        summary: 'List applications',
        response: { 200: listOf(applicationObject), 401: errorObject, 403: errorObject },
      },
    },
    (request, reply) => controller.listApps(request, reply),
  );

  app.get(
    '/api/v1/apps/:appId',
    {
      preHandler: read,
      schema: {
        tags,
        summary: 'Retrieve an application',
        params: appParams,
        response: { 200: applicationObject, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.getApp(request, reply),
  );

  app.post(
    '/api/v1/apps/:appId/keys',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Issue a virtual key (plaintext returned once)',
        params: appParams,
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 200 },
            environment: { type: 'string', enum: ['live', 'test'] },
          },
        },
        response: { 201: issuedKeyObject, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.issueKey(request, reply),
  );

  app.get(
    '/api/v1/apps/:appId/keys',
    {
      preHandler: read,
      schema: {
        tags,
        summary: 'List an application’s virtual keys (never returns secrets)',
        params: appParams,
        response: {
          200: listOf(virtualKeyObject),
          401: errorObject,
          403: errorObject,
          404: errorObject,
        },
      },
    },
    (request, reply) => controller.listKeys(request, reply),
  );

  app.post(
    '/api/v1/keys/:keyId/rotate',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Rotate a key: issue a successor, grace the predecessor',
        params: keyParams,
        response: {
          200: issuedKeyObject,
          400: errorObject,
          401: errorObject,
          403: errorObject,
          404: errorObject,
        },
      },
    },
    (request, reply) => controller.rotateKey(request, reply),
  );

  app.post(
    '/api/v1/keys/:keyId/revoke',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Revoke a key immediately (data plane rejects it ≤1s later)',
        params: keyParams,
        response: { 200: virtualKeyObject, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.revokeKey(request, reply),
  );
}
