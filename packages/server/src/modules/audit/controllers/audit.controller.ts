/**
 * Audit controller (Week 3 Day 12) — HTTP boundary only. Resolves the caller's org from the verified
 * JWT (never the client body), validates paging params, and shapes the list envelope. No business
 * logic, no SQL. Errors are thrown as RelayError and formatted centrally by the app's errorHandler.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from '@relay/shared';
import type { AuditService } from '../types/audit.types.js';

interface ListQuery {
  limit?: number;
  before?: number;
}

export interface AuditController {
  list(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function createAuditController(service: AuditService): AuditController {
  function orgOf(request: FastifyRequest): string {
    const orgId = request.claims?.orgId;
    if (!orgId) {
      throw new RelayError('invalid_request', {
        message: 'This token is not scoped to an organization.',
      });
    }
    return orgId;
  }

  return {
    async list(request, reply) {
      const query = (request.query ?? {}) as ListQuery;
      const opts = {
        limit: query.limit ?? 50,
        ...(query.before !== undefined ? { before: query.before } : {}),
      };
      const data = await service.list(orgOf(request), opts);
      return reply.send({ object: 'list', data });
    },
  };
}
