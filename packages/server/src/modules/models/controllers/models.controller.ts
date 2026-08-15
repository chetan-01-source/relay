/**
 * Models controller (playbook §5) — HTTP boundary. Shapes the OpenAI list/response envelope
 * and status codes. No business logic, no SQL. Depends on the ModelsService interface.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from 'relay-shared';
import type { ModelsService } from '../types/models.types.js';

export interface ModelsController {
  list(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  getOne(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  searchCatalog(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

/** Enough to fill a dropdown, small enough that a typo-wide search cannot return the whole table. */
const DEFAULT_CATALOG_LIMIT = 100;
const MAX_CATALOG_LIMIT = 500;

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

    async searchCatalog(request, reply) {
      const query = request.query as { provider?: string; q?: string; limit?: number };
      // Trimmed here rather than in the service: a search of only spaces is a UI artifact (the user
      // cleared the box), and it should mean "no filter", not "match models containing a space".
      const search = query.q?.trim();
      const [data, counts] = await Promise.all([
        service.searchCatalog({
          ...(query.provider ? { provider: query.provider } : {}),
          ...(search ? { search } : {}),
          limit: Math.min(query.limit ?? DEFAULT_CATALOG_LIMIT, MAX_CATALOG_LIMIT),
        }),
        service.catalogCounts(),
      ]);
      // `counts` rides along so the picker can say "openai has 2 models — run make sync-models"
      // instead of silently looking broken.
      return reply.send({ object: 'list', data, counts });
    },
  };
}
