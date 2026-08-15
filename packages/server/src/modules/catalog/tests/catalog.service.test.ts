/**
 * Catalog sync service, against a fake repository and a stubbed fetch. What matters here is the
 * decision-making — what gets written, what does not, and what happens when a provider misbehaves —
 * so no network and no database are involved.
 */
import { describe, expect, it, vi } from 'vitest';
import { createCatalogService, envKeyName } from '../services/catalog.service.js';
import type {
  CatalogRepository,
  CatalogRow,
  RateCardRow,
  SyncCredentialRow,
} from '../types/catalog.types.js';

function fakeRepo(
  seed: {
    models?: CatalogRow[];
    prices?: RateCardRow[];
    credentials?: SyncCredentialRow[];
  } = {},
) {
  const upserts: { provider: string; model: string; capabilities: unknown }[] = [];
  const priceWrites: { model: string; input: number; output: number }[] = [];
  const repo: CatalogRepository = {
    listSyncCredentials: () => Promise.resolve(seed.credentials ?? []),
    listForProvider: (provider) =>
      Promise.resolve((seed.models ?? []).filter((m) => m.provider === provider)),
    currentPrices: (provider) =>
      Promise.resolve((seed.prices ?? []).filter((p) => p.provider === provider)),
    upsertModel: (provider, model, capabilities) => {
      upserts.push({ provider, model, capabilities });
      return Promise.resolve();
    },
    replacePrice: (_provider, model, input, output) => {
      priceWrites.push({ model, input, output });
      return Promise.resolve();
    },
  };
  return { repo, upserts, priceWrites };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const OPENROUTER_BODY = {
  data: [
    { id: 'openai/gpt-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } },
    { id: 'free/model', pricing: { prompt: '0', completion: '0' } },
  ],
};

describe('catalog sync', () => {
  it('adds every discovered model and its price on a first run', async () => {
    const { repo, upserts, priceWrites } = fakeRepo();
    const service = createCatalogService({
      repo,
      fetch: vi.fn().mockResolvedValue(jsonResponse(OPENROUTER_BODY)),
    });

    const [result] = await service.sync(['openrouter']);

    expect(result!).toMatchObject({
      provider: 'openrouter',
      discovered: 2,
      modelsAdded: 2,
      modelsUpdated: 0,
      pricesChanged: 2,
    });
    expect(upserts).toHaveLength(2);
    expect(priceWrites[0]).toEqual({ model: 'openai/gpt-4o', input: 0.0025, output: 0.01 });
  });

  it('writes nothing on a re-sync when nothing changed', async () => {
    const { repo, upserts, priceWrites } = fakeRepo({
      models: [
        {
          provider: 'openrouter',
          model: 'openai/gpt-4o',
          capabilities: { modalities: ['text'], streaming: true, tools: false },
        },
        {
          provider: 'openrouter',
          model: 'free/model',
          capabilities: { modalities: ['text'], streaming: true, tools: false },
        },
      ],
      prices: [
        {
          provider: 'openrouter',
          model: 'openai/gpt-4o',
          input_usd_per_1k: '0.002500',
          output_usd_per_1k: '0.010000',
        },
        {
          provider: 'openrouter',
          model: 'free/model',
          input_usd_per_1k: '0.000000',
          output_usd_per_1k: '0.000000',
        },
      ],
    });
    const service = createCatalogService({
      repo,
      fetch: vi.fn().mockResolvedValue(jsonResponse(OPENROUTER_BODY)),
    });

    const [result] = await service.sync(['openrouter']);

    // Idempotence is the property that makes this safe to run from cron.
    expect(result!).toMatchObject({ modelsAdded: 0, modelsUpdated: 0, pricesChanged: 0 });
    expect(upserts).toEqual([]);
    expect(priceWrites).toEqual([]);
  });

  it('opens a new rate-card version when a price moves', async () => {
    const { repo, priceWrites } = fakeRepo({
      models: [
        {
          provider: 'openrouter',
          model: 'openai/gpt-4o',
          capabilities: { modalities: ['text'], streaming: true, tools: false },
        },
      ],
      prices: [
        {
          provider: 'openrouter',
          model: 'openai/gpt-4o',
          input_usd_per_1k: '0.009000',
          output_usd_per_1k: '0.010000',
        },
      ],
    });
    const service = createCatalogService({
      repo,
      fetch: vi.fn().mockResolvedValue(
        jsonResponse({
          data: [{ id: 'openai/gpt-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } }],
        }),
      ),
    });

    const [result] = await service.sync(['openrouter']);

    expect(result!.pricesChanged).toBe(1);
    expect(priceWrites).toEqual([{ model: 'openai/gpt-4o', input: 0.0025, output: 0.01 }]);
  });

  it('reports an unreachable provider without failing the run', async () => {
    const { repo } = fakeRepo();
    const service = createCatalogService({
      repo,
      fetch: vi.fn().mockResolvedValue(new Response('nope', { status: 503 })),
    });

    const [result] = await service.sync(['openrouter']);

    expect(result!.error).toBe('HTTP 503');
    expect(result!.discovered).toBe(0);
  });

  it('keeps going after one provider fails — the others still refresh', async () => {
    const { repo } = fakeRepo();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'llama-3.3-70b' }] }));
    const service = createCatalogService({
      repo,
      fetch: fetchMock,
      apiKeyFor: () => 'test-key',
    });

    const results = await service.sync(['openrouter', 'groq']);

    expect(results[0]!.error).toBe('connect ECONNREFUSED');
    expect(results[1]).toMatchObject({ provider: 'groq', discovered: 1, modelsAdded: 1 });
  });

  it('skips a key-requiring provider with no key, naming the variable to set', async () => {
    const { repo } = fakeRepo();
    const fetchMock = vi.fn();
    const service = createCatalogService({ repo, fetch: fetchMock, apiKeyFor: () => undefined });

    const [result] = await service.sync(['groq']);

    expect(result!.error).toContain('RELAY_SYNC_KEY_GROQ');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('needs no key for OpenRouter, which is why it is the default pricing source', async () => {
    const { repo } = fakeRepo();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(OPENROUTER_BODY));
    const service = createCatalogService({ repo, fetch: fetchMock, apiKeyFor: () => undefined });

    const [result] = await service.sync(['openrouter']);

    expect(result!.error).toBeUndefined();
    expect(result!.discovered).toBe(2);
  });

  it('sends Anthropic its own auth headers, not a bearer token', async () => {
    const { repo } = fakeRepo();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'claude-x' }] }));
    const service = createCatalogService({ repo, fetch: fetchMock, apiKeyFor: () => 'sk-ant' });

    await service.sync(['anthropic']);

    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.authorization).toBeUndefined();
  });

  it('ignores a provider id it does not know', async () => {
    const { repo } = fakeRepo();
    const service = createCatalogService({ repo, fetch: vi.fn() });
    expect(await service.sync(['not-a-provider'])).toEqual([]);
  });

  it('defaults to every provider that publishes a model list', async () => {
    const { repo } = fakeRepo();
    const service = createCatalogService({
      repo,
      fetch: vi.fn().mockResolvedValue(jsonResponse({ data: [] })),
      apiKeyFor: () => 'k',
    });

    const results = await service.sync();

    const ids = results.map((r) => r.provider);
    expect(ids).toContain('openrouter');
    expect(ids).toContain('anthropic');
    // Azure has no default base URL (it is per-resource) and Perplexity publishes no list, so
    // neither can be swept — including them would report a failure on every run.
    expect(ids).not.toContain('azure_openai');
    expect(ids).not.toContain('perplexity');
  });
});

describe('envKeyName', () => {
  it('maps a provider id to its environment variable', () => {
    expect(envKeyName('openrouter')).toBe('RELAY_SYNC_KEY_OPENROUTER');
    expect(envKeyName('azure_openai')).toBe('RELAY_SYNC_KEY_AZURE_OPENAI');
  });
});

describe('syncing with the operator’s stored credentials', () => {
  const credential: SyncCredentialRow = {
    provider: 'openai',
    base_url: null,
    ciphertext: Buffer.from('ct'),
    iv: Buffer.from('iv'),
    auth_tag: Buffer.from('tag'),
    wrapped_dek: Buffer.from('dek'),
  };

  /**
   * The reason this exists: a self-hosted operator who has already saved an OpenAI key in the
   * console should not also have to export RELAY_SYNC_KEY_OPENAI to list the models that key can
   * already reach. Before this, their catalog stayed at the two seeded models.
   */
  it('uses a stored credential when no environment key is set', async () => {
    const { repo } = fakeRepo({ credentials: [credential] });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-4o' }] }));
    const service = createCatalogService({
      repo,
      fetch: fetchMock,
      apiKeyFor: () => undefined,
      openCredential: () => 'sk-from-console',
    });

    const [result] = await service.sync(['openai']);

    expect(result!.error).toBeUndefined();
    expect(result!.modelsAdded).toBe(1);
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-from-console');
  });

  it('prefers the environment key, which is a deliberate operator choice', async () => {
    const { repo } = fakeRepo({ credentials: [credential] });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const service = createCatalogService({
      repo,
      fetch: fetchMock,
      apiKeyFor: () => 'sk-from-env',
      openCredential: () => 'sk-from-console',
    });

    await service.sync(['openai']);

    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-from-env');
  });

  it('never opens stored credentials when the opener is absent (the cloud edition)', async () => {
    const { repo } = fakeRepo({ credentials: [credential] });
    const fetchMock = vi.fn();
    const service = createCatalogService({ repo, fetch: fetchMock, apiKeyFor: () => undefined });

    const [result] = await service.sync(['openai']);

    expect(result!.error).toContain('RELAY_SYNC_KEY_OPENAI');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps going when one credential cannot be unsealed', async () => {
    // Expected after a master-key rotation: that provider is skipped, the rest still sync.
    const { repo } = fakeRepo({ credentials: [credential] });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const service = createCatalogService({
      repo,
      fetch: fetchMock,
      apiKeyFor: () => undefined,
      openCredential: () => {
        throw new Error('bad master key');
      },
    });

    const [result] = await service.sync(['openai']);

    expect(result!.error).toContain('needs a key');
  });
});
