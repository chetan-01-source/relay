/**
 * Providers controller — HTTP boundary for the org-scoped credential store. The tenant is the
 * caller's own org, taken from the verified JWT (never the body). Reads the request, calls the
 * service, shapes the envelope. No logic, no SQL. The request body's `apiKey` is the only place a
 * secret enters; it is sealed by the service and never echoed back.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from '@relay/shared';
import type { CreateCredentialInput, ProvidersService } from '../types/providers.types.js';

interface CredentialParams {
  id: string;
}

export interface ProvidersController {
  create(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  list(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  getOne(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  remove(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function createProvidersController(service: ProvidersService): ProvidersController {
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
    async create(request, reply) {
      const body = request.body as CreateCredentialInput;
      const credential = await service.createCredential(actorOf(request), orgOf(request), {
        name: body.name,
        provider: body.provider,
        apiKey: body.apiKey,
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
      });
      return reply.code(201).send(credential);
    },

    async list(request, reply) {
      return reply.send({ object: 'list', data: await service.listCredentials(orgOf(request)) });
    },

    async getOne(request, reply) {
      const { id } = request.params as CredentialParams;
      const credential = await service.getCredential(orgOf(request), id);
      if (!credential) {
        throw new RelayError('not_found', { message: `Credential '${id}' not found.` });
      }
      return reply.send(credential);
    },

    async remove(request, reply) {
      const { id } = request.params as CredentialParams;
      await service.deleteCredential(actorOf(request), orgOf(request), id);
      return reply.code(204).send();
    },
  };
}
