/**
 * Routes controller — HTTP boundary for the routes editor. The tenant is the caller's own org, taken
 * from the verified JWT (never the body). Validates params, calls the service, shapes the envelope.
 * No business logic, no SQL.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from '@relay-ai/shared';
import type { CreateRouteInput, CreateVersionInput, RoutesService } from '../types/routes.types.js';

interface RouteParams {
  routeId: string;
}

export interface RoutesController {
  listRoutes(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  getRoute(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  createRoute(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  addVersion(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  activateVersion(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  setCache(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  deleteRoute(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function createRoutesController(service: RoutesService): RoutesController {
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
    async listRoutes(request, reply) {
      return reply.send({ object: 'list', data: await service.listRoutes(orgOf(request)) });
    },

    async getRoute(request, reply) {
      const { routeId } = request.params as RouteParams;
      const route = await service.getRoute(orgOf(request), routeId);
      if (!route) throw new RelayError('not_found', { message: `Route '${routeId}' not found.` });
      return reply.send(route);
    },

    async createRoute(request, reply) {
      const body = request.body as CreateRouteInput;
      const route = await service.createRoute(actorOf(request), orgOf(request), body);
      return reply.code(201).send(route);
    },

    async addVersion(request, reply) {
      const { routeId } = request.params as RouteParams;
      const body = request.body as CreateVersionInput;
      const route = await service.addVersion(actorOf(request), orgOf(request), routeId, body);
      return reply.code(201).send(route);
    },

    async activateVersion(request, reply) {
      const { routeId } = request.params as RouteParams;
      const body = request.body as { version_id: string };
      const route = await service.activateVersion(
        actorOf(request),
        orgOf(request),
        routeId,
        body.version_id,
      );
      return reply.send(route);
    },

    async setCache(request, reply) {
      const { routeId } = request.params as RouteParams;
      const body = request.body as { cache_enabled: boolean };
      const route = await service.setCacheEnabled(
        actorOf(request),
        orgOf(request),
        routeId,
        body.cache_enabled,
      );
      return reply.send(route);
    },

    async deleteRoute(request, reply) {
      const { routeId } = request.params as RouteParams;
      await service.deleteRoute(actorOf(request), orgOf(request), routeId);
      return reply.code(204).send();
    },
  };
}
