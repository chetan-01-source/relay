/**
 * Catalog sync — refresh `model_catalog` and `rate_cards` from the providers themselves.
 *
 * The alternative is a hand-written seed migration, and it decays the day it merges: model ids
 * change, vendors add families weekly, and prices move. A stale catalog is not a cosmetic problem —
 * `model_catalog` gates routing (an absent model is `model_not_found`) and `rate_cards` decides what
 * a request costs, which feeds budget enforcement. Reading both from the provider means the numbers
 * are the vendor's, not a guess committed months ago.
 *
 * Credentials: providers that require a key read it from `RELAY_SYNC_KEY_<PROVIDER>` — deliberately
 * NOT from a tenant's stored credentials. The catalog is global, and syncing it with one customer's
 * key would let that customer's entitlements decide what every other tenant may route to.
 * OpenRouter needs no key at all, which is why it is the best single source here.
 */
import { isKnownProvider, PROVIDERS, providerInfo, type ProviderId } from 'relay-shared';
import { capabilitiesChanged, parserFor, priceChanged } from '../lib/model-list.js';
import type {
  CatalogRepository,
  CatalogService,
  DiscoveredModel,
  ProviderSyncResult,
} from '../types/catalog.types.js';

export interface CatalogServiceDeps {
  repo: CatalogRepository;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Reads a provider's sync key. Injected so tests need no environment. */
  apiKeyFor?: (provider: ProviderId) => string | undefined;
  /** How long to wait on one provider before giving up and moving to the next. */
  timeoutMs?: number;
}

/** `RELAY_SYNC_KEY_OPENROUTER`, `RELAY_SYNC_KEY_AZURE_OPENAI`, … */
export function envKeyName(provider: string): string {
  return `RELAY_SYNC_KEY_${provider.toUpperCase()}`;
}

function defaultApiKeyFor(provider: ProviderId): string | undefined {
  return process.env[envKeyName(provider)];
}

export function createCatalogService(deps: CatalogServiceDeps): CatalogService {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const apiKeyFor = deps.apiKeyFor ?? defaultApiKeyFor;
  const timeoutMs = deps.timeoutMs ?? 20_000;

  /** Provider-specific auth. Anthropic uses `x-api-key`; the OpenAI family uses a bearer. */
  function headersFor(provider: ProviderId, apiKey: string | undefined): Record<string, string> {
    if (!apiKey) return { accept: 'application/json' };
    if (provider === 'anthropic') {
      return {
        accept: 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      };
    }
    return { accept: 'application/json', authorization: `Bearer ${apiKey}` };
  }

  async function discover(provider: ProviderId): Promise<DiscoveredModel[]> {
    const info = providerInfo(provider);
    if (!info) throw new Error(`unknown provider ${provider}`);
    if (!info.modelsPath) throw new Error('publishes no model list');
    if (!info.defaultBaseUrl) throw new Error('has no default base URL to query');

    const apiKey = apiKeyFor(provider);
    if (info.requiresApiKey && !apiKey && !info.publishesPricing) {
      throw new Error(`needs a key — set ${envKeyName(provider)}`);
    }

    // A provider that hangs must not hang the whole sync; each gets its own budget.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${info.defaultBaseUrl}${info.modelsPath}`, {
        headers: headersFor(provider, apiKey),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parserFor(provider)(await response.json());
    } finally {
      clearTimeout(timer);
    }
  }

  async function syncOne(provider: ProviderId): Promise<ProviderSyncResult> {
    const result: ProviderSyncResult = {
      provider,
      discovered: 0,
      modelsAdded: 0,
      modelsUpdated: 0,
      pricesChanged: 0,
    };

    let discovered: DiscoveredModel[];
    try {
      discovered = await discover(provider);
    } catch (err) {
      // One unreachable provider must not abort the others: a sync that refreshes eleven catalogs
      // and reports the twelfth as failed is far more useful than one that refreshes none.
      result.error = err instanceof Error ? err.message : 'unknown error';
      return result;
    }

    result.discovered = discovered.length;

    const existing = new Map(
      (await deps.repo.listForProvider(provider)).map((row) => [row.model, row.capabilities]),
    );
    const priceByModel = new Map(
      (await deps.repo.currentPrices(provider)).map((row) => [row.model, row] as const),
    );

    for (const model of discovered) {
      const capabilities = model.capabilities ?? { modalities: ['text'] };
      const known = existing.get(model.model);
      if (known === undefined) {
        await deps.repo.upsertModel(provider, model.model, capabilities);
        result.modelsAdded += 1;
      } else if (capabilitiesChanged(known, capabilities)) {
        await deps.repo.upsertModel(provider, model.model, capabilities);
        result.modelsUpdated += 1;
      }

      if (model.inputUsdPer1k === undefined || model.outputUsdPer1k === undefined) continue;

      const current = priceByModel.get(model.model);
      const isNew = current === undefined;
      const moved =
        !isNew &&
        priceChanged(
          current.input_usd_per_1k,
          current.output_usd_per_1k,
          model.inputUsdPer1k,
          model.outputUsdPer1k,
        );
      if (isNew || moved) {
        await deps.repo.replacePrice(
          provider,
          model.model,
          model.inputUsdPer1k,
          model.outputUsdPer1k,
        );
        result.pricesChanged += 1;
      }
    }

    return result;
  }

  return {
    async sync(providers) {
      // Named providers are filtered to the ones we know; an unrecognised id is dropped rather than
      // attempted. With no argument, sweep every provider that both publishes a list and has an
      // address to fetch it from — including the others would report a failure on every run.
      const targets: ProviderId[] = providers
        ? providers.filter(isKnownProvider)
        : PROVIDERS.filter((p) => p.modelsPath !== null && p.defaultBaseUrl !== null).map(
            (p) => p.id,
          );

      // Sequential on purpose. This is an operator command run occasionally, not a hot path, and
      // hitting a dozen vendors at once is a good way to trip someone's rate limiter for no gain.
      const results: ProviderSyncResult[] = [];
      for (const provider of targets) results.push(await syncOne(provider));
      return results;
    },
  };
}
