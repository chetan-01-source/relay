/**
 * Tenancy controller — HTTP boundary for the platform control plane. Reads the request (already
 * structurally validated by the route schema), derives the actor from the verified JWT, calls the
 * service, and shapes the response envelope. No business logic, no SQL. Errors are thrown as
 * RelayError and formatted centrally by app.ts.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from '@relay-ai/shared';
import type {
  EntitlementTemplateName,
  OnboardingState,
  TenancyService,
} from '../types/tenancy.types.js';

interface OrgParams {
  orgId: string;
}
interface MemberParams {
  orgId: string;
  userId: string;
}
interface OrgInvitationParams {
  orgId: string;
  invitationId: string;
}
interface InvitationParams {
  invitationId: string;
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
  listMembers(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  inviteMember(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  removeMember(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  setMemberRole(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  listInvitations(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  resendInvitation(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  revokeInvitation(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  /** Invitee-facing: read the invitation addressed to the signed-in caller. */
  getInvitation(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  /** Invitee-facing: accept it, which is what creates the membership. */
  acceptInvitation(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function createTenancyController(service: TenancyService): TenancyController {
  /** The verified caller id (authJwt guarantees claims are present before this runs). */
  function actorOf(request: FastifyRequest): string {
    return request.claims?.userId ?? 'system';
  }

  /**
   * The Logto user id of the caller. Unlike `actorOf` this refuses to fall back to a placeholder:
   * the invitation endpoints authorize by comparing this id's account against the invited address,
   * and a fallback would turn "no subject in the token" into a lookup that quietly fails open-ended.
   */
  function userOf(request: FastifyRequest): string {
    const userId = request.claims?.userId;
    if (!userId) {
      throw new RelayError('invalid_api_key', { message: 'This token identifies no user.' });
    }
    return userId;
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

    async listMembers(request, reply) {
      const { orgId } = request.params as OrgParams;
      return reply.send({ object: 'list', data: await service.listMembers(orgId) });
    },

    async inviteMember(request, reply) {
      const { orgId } = request.params as OrgParams;
      const body = request.body as { email: string; role?: 'admin' | 'member' };
      const invitation = await service.inviteMember(
        actorOf(request),
        orgId,
        body.email,
        body.role ?? 'member',
      );
      return reply.code(201).send(invitation);
    },

    async removeMember(request, reply) {
      const { orgId, userId } = request.params as MemberParams;
      await service.removeMember(actorOf(request), orgId, userId);
      return reply.code(204).send();
    },

    async setMemberRole(request, reply) {
      const { orgId, userId } = request.params as MemberParams;
      const body = request.body as { role: 'admin' | 'member' };
      return reply.send(await service.setMemberRole(actorOf(request), orgId, userId, body.role));
    },

    async listInvitations(request, reply) {
      const { orgId } = request.params as OrgParams;
      return reply.send({ object: 'list', data: await service.listInvitations(orgId) });
    },

    async resendInvitation(request, reply) {
      const { orgId, invitationId } = request.params as OrgInvitationParams;
      return reply.send(await service.resendInvitation(actorOf(request), orgId, invitationId));
    },

    async revokeInvitation(request, reply) {
      const { orgId, invitationId } = request.params as OrgInvitationParams;
      await service.revokeInvitation(actorOf(request), orgId, invitationId);
      return reply.code(204).send();
    },

    async getInvitation(request, reply) {
      const { invitationId } = request.params as InvitationParams;
      return reply.send(await service.getInvitationOffer(userOf(request), invitationId));
    },

    async acceptInvitation(request, reply) {
      const { invitationId } = request.params as InvitationParams;
      return reply.send(await service.acceptInvitation(userOf(request), invitationId));
    },
  };
}
