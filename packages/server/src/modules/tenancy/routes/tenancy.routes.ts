/**
 * Tenancy routes — control-plane HTTP surface (/api/v1/platform/orgs/*). Every route's `schema` block
 * does triple duty: request validation, Swagger UI, and the generated OpenAPI spec. All routes are
 * guarded by the identity preHandlers the composition root injects: authJwt (401 without a valid
 * Logto JWT) then requireScope('platform:admin') (403 without platform-admin) — these are operator
 * operations that manage tenants.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthPreHandler } from '../../identity/index.js';
import type { TenancyController } from '../controllers/tenancy.controller.js';

// Full OpenAI-compatible error envelope — list every field or Fastify strips the omitted ones.
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

const organizationObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    id: { type: 'string' },
    name: { type: 'string' },
    status: { type: 'string', enum: ['active', 'suspended'] },
    onboarding_state: {
      type: 'string',
      enum: ['created', 'admin_invited', 'provider_added', 'first_request'],
    },
    logto_org_id: { type: 'string' },
    created_at: { type: 'string' },
  },
};

const entitlementsObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    org_id: { type: 'string' },
    features: { type: 'object', additionalProperties: true },
  },
};

const orgParams = {
  type: 'object',
  required: ['orgId'],
  properties: { orgId: { type: 'string', format: 'uuid' } },
};

// A pragmatic email check at the boundary (Fastify's default ajv has no 'email' format registered).
const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$';

export interface TenancyRouteGuards {
  authJwt: AuthPreHandler;
  requireScope: (...scopes: string[]) => AuthPreHandler;
}

export function registerTenancyRoutes(
  app: FastifyInstance,
  controller: TenancyController,
  guards: TenancyRouteGuards,
): void {
  const preHandler = [guards.authJwt, guards.requireScope('platform:admin')];
  const tags = ['tenancy'];

  app.post(
    '/api/v1/platform/orgs',
    {
      preHandler,
      schema: {
        tags,
        summary: 'Onboard a new organization (Logto org + entitlements + admin invite)',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            adminEmail: { type: 'string', pattern: EMAIL_PATTERN },
            template: { type: 'string', enum: ['default', 'trial', 'internal'] },
          },
        },
        response: { 201: organizationObject, 401: errorObject, 403: errorObject, 409: errorObject },
      },
    },
    (request, reply) => controller.onboard(request, reply),
  );

  app.get(
    '/api/v1/platform/orgs',
    {
      preHandler,
      schema: {
        tags,
        summary: 'List organizations',
        response: {
          200: {
            type: 'object',
            properties: {
              object: { type: 'string' },
              data: { type: 'array', items: organizationObject },
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
    '/api/v1/platform/orgs/:orgId',
    {
      preHandler,
      schema: {
        tags,
        summary: 'Retrieve an organization',
        params: orgParams,
        response: { 200: organizationObject, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.getOne(request, reply),
  );

  app.post(
    '/api/v1/platform/orgs/:orgId/suspend',
    {
      preHandler,
      schema: {
        tags,
        summary: 'Suspend an organization (data plane rejects its keys ≤1s later)',
        params: orgParams,
        response: { 200: organizationObject, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.suspend(request, reply),
  );

  app.post(
    '/api/v1/platform/orgs/:orgId/unsuspend',
    {
      preHandler,
      schema: {
        tags,
        summary: 'Reactivate a suspended organization',
        params: orgParams,
        response: { 200: organizationObject, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.unsuspend(request, reply),
  );

  app.get(
    '/api/v1/platform/orgs/:orgId/entitlements',
    {
      preHandler,
      schema: {
        tags,
        summary: "Read an organization's entitlement flags",
        params: orgParams,
        response: { 200: entitlementsObject, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.getEntitlements(request, reply),
  );

  app.put(
    '/api/v1/platform/orgs/:orgId/entitlements',
    {
      preHandler,
      schema: {
        tags,
        summary: "Replace/merge an organization's entitlement flags (hot-reloaded ≤1s)",
        params: orgParams,
        body: {
          type: 'object',
          required: ['features'],
          properties: { features: { type: 'object', additionalProperties: true } },
        },
        response: { 200: entitlementsObject, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.updateEntitlements(request, reply),
  );

  app.post(
    '/api/v1/platform/orgs/:orgId/onboarding/advance',
    {
      preHandler,
      schema: {
        tags,
        summary: 'Advance the onboarding state machine one step',
        params: orgParams,
        body: {
          type: 'object',
          required: ['state'],
          properties: {
            state: {
              type: 'string',
              enum: ['admin_invited', 'provider_added', 'first_request'],
            },
          },
        },
        response: { 200: organizationObject, 400: errorObject, 401: errorObject, 403: errorObject },
      },
    },
    (request, reply) => controller.advanceOnboarding(request, reply),
  );
}
