/**
 * Identity controller — HTTP boundary for the control plane's whoami. Returns the verified caller's
 * tenant context (from the JWT the authJwt preHandler resolved). No business logic, no SQL. This is
 * the first /api/* route; it exists to exercise the two-plane auth contract (401 without a valid
 * JWT, 403 without the required scope) end-to-end. Tenancy CRUD lands with the Day 7 module.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from '@relay/shared';

export interface IdentityController {
  me(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function createIdentityController(): IdentityController {
  return {
    async me(request, reply) {
      const claims = request.claims;
      if (!claims) {
        // Unreachable when authJwt precedes this handler; defensive for misconfigured wiring.
        throw new RelayError('invalid_api_key', { message: 'Authentication required.' });
      }
      return reply.send({
        object: 'identity',
        user_id: claims.userId,
        org_id: claims.orgId,
        scopes: claims.scopes,
        is_platform_admin: claims.isPlatformAdmin,
      });
    },
  };
}
