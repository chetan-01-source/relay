import { describe, it, expect } from 'vitest';
import {
  listModelsQuery,
  getModelQuery,
  searchCatalogQuery,
  countModelsByProviderQuery,
} from '../queries/models.queries.js';
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
    search: async () => [],
    countByProvider: async () => [],
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

describe('catalog search', () => {
  it('binds provider and search as parameters, never interpolating', () => {
    const hostile = "openai'; DROP TABLE model_catalog; --";
    const query = searchCatalogQuery(hostile, hostile, 50);
    expect(query.text).not.toContain('DROP TABLE');
    expect(query.values).toEqual([hostile, hostile, 50]);
  });

  it('treats an absent provider or search as "no filter" via SQL null guards', () => {
    // The predicate shape is fixed and the optional halves are switched off with IS NULL, so the
    // statement never has to be assembled by concatenating clauses in JavaScript.
    const query = searchCatalogQuery(undefined, undefined, 25);
    expect(query.text).toContain('$1::text IS NULL OR provider = $1');
    expect(query.text).toContain('$2::text IS NULL OR model ILIKE');
    expect(query.values).toEqual([null, null, 25]);
  });

  it('always caps the result set', () => {
    expect(searchCatalogQuery(undefined, undefined, 10).text).toContain('LIMIT $3');
  });

  it('counts models per provider, which drives the "catalog looks empty" hint', () => {
    const query = countModelsByProviderQuery();
    expect(query.text).toContain('GROUP BY provider');
    expect(query.values).toEqual([]);
  });
});

describe('models.service catalog mapping', () => {
  const catalogRepo: ModelsRepository = {
    list: async () => [],
    getById: async () => null,
    search: async () => [
      { provider: 'openai', model: 'gpt-4o', capabilities: { modalities: ['text'] } },
    ],
    countByProvider: async () => [
      { provider: 'openai', count: 132 },
      { provider: 'anthropic', count: 2 },
    ],
  };

  it('shapes rows into catalog objects', async () => {
    const service = createModelsService(catalogRepo);
    const models = await service.searchCatalog({ limit: 10 });
    expect(models).toEqual([
      {
        object: 'catalog.model',
        provider: 'openai',
        model: 'gpt-4o',
        capabilities: { modalities: ['text'] },
      },
    ]);
  });

  it('returns counts keyed by provider so the picker can spot an unsynced one', async () => {
    const service = createModelsService(catalogRepo);
    expect(await service.catalogCounts()).toEqual({ openai: 132, anthropic: 2 });
  });
});
