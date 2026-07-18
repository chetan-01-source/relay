/**
 * Models repository (playbook §9) — the data-access layer. Executes the parametrized queries
 * from models.queries.ts against an injected Queryable (the DB singleton in prod, a fake in
 * tests). Contains NO query text of its own and NO business logic.
 */
import type { Queryable } from '../../../platform/db.js';
import { listModelsQuery, getModelQuery } from '../queries/models.queries.js';
import type { ModelCatalogRow, ModelsRepository } from '../types/models.types.js';

export function createModelsRepository(db: Queryable): ModelsRepository {
  return {
    list() {
      return db.run<ModelCatalogRow>(listModelsQuery());
    },
    async getById(model) {
      const rows = await db.run<ModelCatalogRow>(getModelQuery(model));
      return rows[0] ?? null;
    },
  };
}
