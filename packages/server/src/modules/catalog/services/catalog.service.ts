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
import { matchPrices } from '../lib/price-match.js';

/**
 * Whose published prices stand in for a provider that publishes none. OpenRouter is the only one
 * that returns per-token prices from its models endpoint, and it carries the same vendor models.
 */
const PRICE_REFERENCE_PROVIDER = 'openrouter';
import type {
  CatalogRepository,
  SyncCredentialRow,
  CatalogService,
  DiscoveredModel,
  ProviderSyncResult,
  RateCardRow,
} from '../types/catalog.types.js';

export interface CatalogServiceDeps {
  repo: CatalogRepository;
  /**
   * Unseal a stored provider credential so its key can drive the sync. Supplied only in the
   * self-hosted edition — see `sync()`. Absent ⇒ stored credentials are never opened.
   */
  openCredential?: (row: SyncCredentialRow) => string;
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
  const envApiKeyFor = deps.apiKeyFor ?? defaultApiKeyFor;
  const timeoutMs = deps.timeoutMs ?? 20_000;

  /**
   * Keys the operator has already stored in the console, by provider.
   *
   * Filled once per sync, and only when `openCredential` was injected — which the composition root
   * does solely in the self-hosted edition. There, the person who saved the OpenAI key and the person
   * running `relay sync-models` are the same person, and making them ALSO export
   * RELAY_SYNC_KEY_OPENAI to list the models that key can already reach is friction with no security
   * value. In the cloud edition the injection is absent, because a global table read by every tenant
   * must not be populated using one tenant's credential.
   */
  async function storedKeys(): Promise<Map<string, string>> {
    const keys = new Map<string, string>();
    if (!deps.openCredential) return keys;
    for (const row of await deps.repo.listSyncCredentials()) {
      try {
        keys.set(row.provider, deps.openCredential(row));
      } catch {
        // A credential sealed under a different master key cannot be opened. That is an expected
        // state after a key rotation, and it must not abort the sync for every other provider.
      }
    }
    return keys;
  }

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

  async function discover(
    provider: ProviderId,
    stored: Map<string, string>,
  ): Promise<DiscoveredModel[]> {
    const info = providerInfo(provider);
    if (!info) throw new Error(`unknown provider ${provider}`);
    if (!info.modelsPath) throw new Error('publishes no model list');
    if (!info.defaultBaseUrl) throw new Error('has no default base URL to query');

    // The environment wins: an operator who sets RELAY_SYNC_KEY_* is stating a deliberate choice,
    // and it should not be silently overridden by whatever credential happens to be in the database.
    const apiKey = envApiKeyFor(provider) ?? stored.get(provider);
    if (info.requiresApiKey && !apiKey && !info.publishesPricing) {
      throw new Error(
        `needs a key — add a ${provider} credential in the console, or set ${envKeyName(provider)}`,
      );
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

  async function syncOne(
    provider: ProviderId,
    stored: Map<string, string>,
  ): Promise<ProviderSyncResult> {
    const result: ProviderSyncResult = {
      provider,
      discovered: 0,
      modelsAdded: 0,
      modelsUpdated: 0,
      pricesChanged: 0,
    };

    let discovered: DiscoveredModel[];
    try {
      discovered = await discover(provider, stored);
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

    // A provider that publishes no prices of its own leaves every request through it settling at
    // zero. OpenRouter carries the same vendor models WITH prices, so its figure is used for the
    // ones that correspond — see lib/price-match.ts for why that is sound and where it is not.
    if (!providerInfo(provider)?.publishesPricing) {
      result.pricesDerived = await derivePrices(provider, discovered, priceByModel);
      result.pricesChanged += result.pricesDerived;
    }

    return result;
  }

  /** Copy the reference provider's price for each model that has none of its own. */
  async function derivePrices(
    provider: ProviderId,
    discovered: readonly DiscoveredModel[],
    existingPrices: Map<string, RateCardRow>,
  ): Promise<number> {
    // Only models the provider left unpriced: a price the vendor published itself is better
    // evidence than one inferred from a marketplace, and must not be overwritten.
    const unpriced = discovered
      .filter((model) => model.inputUsdPer1k === undefined)
      .map((model) => model.model);
    if (unpriced.length === 0) return 0;

    const reference = (await deps.repo.listReferencePrices(PRICE_REFERENCE_PROVIDER)).map(
      (row) => ({
        model: row.model,
        inputUsdPer1k: Number(row.input_usd_per_1k),
        outputUsdPer1k: Number(row.output_usd_per_1k),
      }),
    );
    if (reference.length === 0) return 0;

    let written = 0;
    for (const [model, priced] of matchPrices(unpriced, reference)) {
      const current = existingPrices.get(model);
      const unchanged =
        current &&
        !priceChanged(
          current.input_usd_per_1k,
          current.output_usd_per_1k,
          priced.inputUsdPer1k,
          priced.outputUsdPer1k,
        );
      if (unchanged) continue;
      await deps.repo.replacePrice(provider, model, priced.inputUsdPer1k, priced.outputUsdPer1k);
      written += 1;
    }
    return written;
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
      const stored = await storedKeys();
      const results: ProviderSyncResult[] = [];
      for (const provider of targets) results.push(await syncOne(provider, stored));
      return results;
    },
  };
}
