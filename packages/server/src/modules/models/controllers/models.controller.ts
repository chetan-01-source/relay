/**
 * Models controller (playbook §5) — HTTP boundary. Shapes the OpenAI list/response envelope
 * and status codes. No business logic, no SQL. Depends on the ModelsService interface.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from '@relay/shared';
import type { ModelsService } from '../types/models.types.js';

export interface ModelsController {
  list(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  getOne(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function createModelsController(service: ModelsService): ModelsController {
  return {
    async list(_request, reply) {
      const data = await service.listModels();
      return reply.send({ object: 'list', data });
    },
    async getOne(request, reply) {
      const { model } = request.params as { model: string };
      const found = await service.getModel(model);
      if (!found) {
        throw new RelayError('model_not_found', {
          message: `The model '${model}' does not exist.`,
        });
      }
      return reply.send(found);
    },
  };
}
