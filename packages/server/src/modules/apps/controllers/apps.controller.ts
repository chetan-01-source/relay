/**
 * Apps controller — HTTP boundary for the org-scoped app + key control plane. The tenant is the
 * caller's own org, taken from the verified JWT (never from the client body), so one org can never
 * touch another's apps. Reads the request, calls the service, shapes the envelope. No logic, no SQL.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from '@relay/shared';
import type { AppsService } from '../types/apps.types.js';

interface AppParams {
  appId: string;
}
interface KeyParams {
  keyId: string;
}

export interface AppsController {
  createApp(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  listApps(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  getApp(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  issueKey(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  listKeys(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  rotateKey(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  revokeKey(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function createAppsController(service: AppsService): AppsController {
  /** The caller's org, from the verified token. Fails loud if the token carries no org context. */
  function orgOf(request: FastifyRequest): string {
    const orgId = request.claims?.orgId;
    if (!orgId) {
      throw new RelayError('invalid_request', {
        message: 'This token is not scoped to an organization.',
      });
    }
    return orgId;
  }

  function actorOf(request: FastifyRequest): string {
    return request.claims?.userId ?? 'system';
  }

  return {
    async createApp(request, reply) {
      const body = request.body as { name: string; description?: string };
      const app = await service.createApp(actorOf(request), orgOf(request), {
        name: body.name,
        ...(body.description ? { description: body.description } : {}),
      });
      return reply.code(201).send(app);
    },

    async listApps(request, reply) {
      return reply.send({ object: 'list', data: await service.listApps(orgOf(request)) });
    },

    async getApp(request, reply) {
      const { appId } = request.params as AppParams;
      const app = await service.getApp(orgOf(request), appId);
      if (!app) throw new RelayError('not_found', { message: `Application '${appId}' not found.` });
      return reply.send(app);
    },

    async issueKey(request, reply) {
      const { appId } = request.params as AppParams;
      const body = (request.body ?? {}) as { name?: string; environment?: 'live' | 'test' };
      const issued = await service.issueKey(actorOf(request), orgOf(request), appId, {
        ...(body.name ? { name: body.name } : {}),
        ...(body.environment ? { environment: body.environment } : {}),
      });
      return reply.code(201).send(issued);
    },

    async listKeys(request, reply) {
      const { appId } = request.params as AppParams;
      return reply.send({ object: 'list', data: await service.listKeys(orgOf(request), appId) });
    },

    async rotateKey(request, reply) {
      const { keyId } = request.params as KeyParams;
      return reply.send(await service.rotateKey(actorOf(request), orgOf(request), keyId));
    },

    async revokeKey(request, reply) {
      const { keyId } = request.params as KeyParams;
      return reply.send(await service.revokeKey(actorOf(request), orgOf(request), keyId));
    },
  };
}
