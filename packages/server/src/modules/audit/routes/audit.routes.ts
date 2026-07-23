/**
 * Audit routes — org-scoped, read-only trail (GET /api/v1/audit). The `schema` block does triple
 * duty: request validation, Swagger UI, and the generated OpenAPI spec. Guarded by the identity
 * preHandlers the composition root injects: authJwt (401) then requireScope('audit:read') (403).
 * The trail is append-only; there is no write endpoint (records are appended by control-plane
 * mutations inside their own transaction). Chain verification is an operator CLI (`relay audit verify`).
 */
import type { FastifyInstance } from 'fastify';
import type { AuthPreHandler } from '../../identity/index.js';
import type { AuditController } from '../controllers/audit.controller.js';

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

const auditRecord = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    id: { type: 'string' },
    seq: { type: 'integer' },
    actor: { type: 'string' },
    action: { type: 'string' },
    target: { type: ['string', 'null'] },
    hash: { type: 'string' },
    created_at: { type: 'string' },
  },
};

const listOf = (item: object) => ({
  type: 'object',
  properties: { object: { type: 'string' }, data: { type: 'array', items: item } },
});

export interface AuditRouteGuards {
  authJwt: AuthPreHandler;
  requireScope: (...scopes: string[]) => AuthPreHandler;
}

export function registerAuditRoutes(
  app: FastifyInstance,
  controller: AuditController,
  guards: AuditRouteGuards,
): void {
  app.get(
    '/api/v1/audit',
    {
      preHandler: [guards.authJwt, guards.requireScope('audit:read')],
      schema: {
        tags: ['audit'],
        summary: 'List the organization’s audit trail (newest first)',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            before: { type: 'integer', minimum: 1 },
          },
        },
        response: { 200: listOf(auditRecord), 401: errorObject, 403: errorObject },
      },
    },
    (request, reply) => controller.list(request, reply),
  );
}
