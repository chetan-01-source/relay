/**
 * Identity routes — control-plane HTTP surface (/api/*). The `schema` block feeds validation +
 * Swagger + the generated OpenAPI spec. Auth is enforced by the preHandlers the composition root
 * passes in: authJwt (401 without a valid Logto JWT) then requireScope (403 without the scope).
 */
import type { FastifyInstance } from 'fastify';
import type { IdentityController } from '../controllers/identity.controller.js';
import type { AuthPreHandler } from '../middleware/auth.js';

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

export interface IdentityRouteGuards {
  authJwt: AuthPreHandler;
  requireScope: (...scopes: string[]) => AuthPreHandler;
}

export function registerIdentityRoutes(
  app: FastifyInstance,
  controller: IdentityController,
  guards: IdentityRouteGuards,
): void {
  app.get(
    '/api/v1/me',
    {
      preHandler: [guards.authJwt, guards.requireScope('relay:read')],
      schema: {
        tags: ['identity'],
        summary: 'Return the authenticated caller (control plane)',
        description:
          'Requires a Logto JWT: `Authorization: Bearer <token>` with the `relay:read` scope. ' +
          'Returns 401 without a valid token and 403 without the scope.',
        response: {
          200: {
            type: 'object',
            properties: {
              object: { type: 'string' },
              user_id: { type: 'string' },
              org_id: { type: ['string', 'null'] },
              scopes: { type: 'array', items: { type: 'string' } },
              is_platform_admin: { type: 'boolean' },
            },
          },
          401: errorObject,
          403: errorObject,
        },
      },
    },
    (request, reply) => controller.me(request, reply),
  );
}
