/**
 * Models service (playbook §5) — business logic. Maps persistence rows to OpenAI API objects.
 * No SQL, no HTTP, no DB handle — depends only on the ModelsRepository interface, so it is
 * unit-testable with a fake repository.
 */
import type {
  ModelCatalogRow,
  ModelsRepository,
  ModelsService,
  OpenAiModel,
} from '../types/models.types.js';

// Stable epoch for the OpenAI `created` field (catalog entries aren't per-request).
const CREATED_EPOCH = 1_700_000_000;

function toOpenAiModel(row: ModelCatalogRow): OpenAiModel {
  return { id: row.model, object: 'model', created: CREATED_EPOCH, owned_by: row.provider };
}

export function createModelsService(repo: ModelsRepository): ModelsService {
  return {
    async listModels() {
      const rows = await repo.list();
      return rows.map(toOpenAiModel);
    },
    async getModel(model) {
      const row = await repo.getById(model);
      return row ? toOpenAiModel(row) : null;
    },
  };
}
