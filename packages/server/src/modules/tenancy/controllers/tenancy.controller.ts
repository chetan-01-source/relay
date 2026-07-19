/**
 * Tenancy controller — HTTP boundary for the platform control plane. Reads the request (already
 * structurally validated by the route schema), derives the actor from the verified JWT, calls the
 * service, and shapes the response envelope. No business logic, no SQL. Errors are thrown as
 * RelayError and formatted centrally by app.ts.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from '@relay/shared';
import type {
  EntitlementTemplateName,
  OnboardingState,
  TenancyService,
} from '../types/tenancy.types.js';

interface OrgParams {
  orgId: string;
}

export interface TenancyController {
  onboard(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  list(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  getOne(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  suspend(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  unsuspend(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  getEntitlements(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  updateEntitlements(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  advanceOnboarding(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function createTenancyController(service: TenancyService): TenancyController {
  /** The verified caller id (authJwt guarantees claims are present before this runs). */
  function actorOf(request: FastifyRequest): string {
    return request.claims?.userId ?? 'system';
  }

  function requireFound<T>(value: T | null, orgId: string): T {
    if (value === null) {
      throw new RelayError('not_found', { message: `Organization '${orgId}' not found.` });
    }
    return value;
  }

  return {
    async onboard(request, reply) {
      const body = request.body as {
        name: string;
        adminEmail?: string;
        template?: EntitlementTemplateName;
      };
      const org = await service.onboardOrg(actorOf(request), {
        name: body.name,
        ...(body.adminEmail ? { adminEmail: body.adminEmail } : {}),
        ...(body.template ? { template: body.template } : {}),
      });
      return reply.code(201).send(org);
    },

    async list(_request, reply) {
      const data = await service.listOrgs();
      return reply.send({ object: 'list', data });
    },

    async getOne(request, reply) {
      const { orgId } = request.params as OrgParams;
      const org = requireFound(await service.getOrg(orgId), orgId);
      return reply.send(org);
    },

    async suspend(request, reply) {
      const { orgId } = request.params as OrgParams;
      return reply.send(await service.suspendOrg(actorOf(request), orgId));
    },

    async unsuspend(request, reply) {
      const { orgId } = request.params as OrgParams;
      return reply.send(await service.unsuspendOrg(actorOf(request), orgId));
    },

    async getEntitlements(request, reply) {
      const { orgId } = request.params as OrgParams;
      const features = await service.getEntitlements(orgId);
      return reply.send({ object: 'entitlements', org_id: orgId, features });
    },

    async updateEntitlements(request, reply) {
      const { orgId } = request.params as OrgParams;
      const body = request.body as { features: Record<string, unknown> };
      const features = await service.updateEntitlements(actorOf(request), orgId, {
        features: body.features,
      });
      return reply.send({ object: 'entitlements', org_id: orgId, features });
    },

    async advanceOnboarding(request, reply) {
      const { orgId } = request.params as OrgParams;
      const body = request.body as { state: OnboardingState };
      return reply.send(await service.advanceOnboarding(actorOf(request), orgId, body.state));
    },
  };
}
