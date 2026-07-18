import { describe, it, expect } from 'vitest';
import { listModelsQuery, getModelQuery } from '../queries/models.queries.js';
import { createModelsService } from '../services/models.service.js';
import { createModelsRepository } from '../repositories/models.repository.js';
import type { ModelCatalogRow, ModelsRepository } from '../types/models.types.js';
import type { Queryable, SqlQuery } from '../../../platform/db.js';

describe('models.queries (parametrized, injection-safe)', () => {
  it('listModelsQuery has no interpolated values', () => {
    const q = listModelsQuery();
    expect(q.text).toMatch(/SELECT .* FROM model_catalog/i);
    expect(q.values).toEqual([]);
  });

  it('getModelQuery binds the id as $1, never interpolated', () => {
    const q = getModelQuery("gpt-4o'; DROP TABLE model_catalog;--");
    expect(q.text).toContain('WHERE model = $1');
    expect(q.text).not.toContain('DROP TABLE');
    expect(q.values).toEqual(["gpt-4o'; DROP TABLE model_catalog;--"]);
  });
});

// A fake Queryable records the query it was handed and returns canned rows.
function fakeDb(rows: ModelCatalogRow[]): Queryable & { lastQuery?: SqlQuery } {
  const db: Queryable & { lastQuery?: SqlQuery } = {
    async run<R>(query: SqlQuery): Promise<R[]> {
      db.lastQuery = query;
      return rows as unknown as R[];
    },
  };
  return db;
}

describe('models.repository (uses queries, no inline SQL)', () => {
  it('list() executes listModelsQuery and returns rows', async () => {
    const db = fakeDb([{ provider: 'openai', model: 'gpt-4o', capabilities: {} }]);
    const repo = createModelsRepository(db);
    const rows = await repo.list();
    expect(rows).toHaveLength(1);
    expect(db.lastQuery?.text).toContain('ORDER BY provider, model');
  });

  it('getById() returns null when no row matches', async () => {
    const repo = createModelsRepository(fakeDb([]));
    expect(await repo.getById('missing')).toBeNull();
  });
});

describe('models.service (maps rows -> OpenAI objects)', () => {
  const repo: ModelsRepository = {
    list: async () => [
      { provider: 'openai', model: 'gpt-4o', capabilities: {} },
      { provider: 'anthropic', model: 'claude-3-5-sonnet', capabilities: {} },
    ],
    getById: async (m) =>
      m === 'gpt-4o' ? { provider: 'openai', model: 'gpt-4o', capabilities: {} } : null,
  };

  it('listModels maps provider -> owned_by with object "model"', async () => {
    const models = await createModelsService(repo).listModels();
    expect(models[0]).toEqual({
      id: 'gpt-4o',
      object: 'model',
      created: 1_700_000_000,
      owned_by: 'openai',
    });
  });

  it('getModel returns null for unknown ids', async () => {
    const svc = createModelsService(repo);
    expect(await svc.getModel('nope')).toBeNull();
    expect((await svc.getModel('gpt-4o'))?.owned_by).toBe('openai');
  });
});
