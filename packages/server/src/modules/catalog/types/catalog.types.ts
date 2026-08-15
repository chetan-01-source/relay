/**
 * Catalog module interfaces. The catalog is the GLOBAL model list and price book — `model_catalog`
 * and `rate_cards`, neither of which carries an `org_id`. Keeping them global is what makes adding a
 * model a data change rather than a per-tenant migration.
 */
import type { ProviderId } from 'relay-shared';

/** What a provider says about one of its models. Pricing is absent unless the provider publishes it. */
export interface DiscoveredModel {
  /** Provider-native model id, exactly as the provider spells it — this is what gets sent upstream. */
  model: string;
  /** Merged into `model_catalog.capabilities`. Absent keys fall back to the conservative default. */
  capabilities?: ModelCapabilities;
  /** USD per 1,000 prompt tokens. Only set when the provider publishes prices. */
  inputUsdPer1k?: number;
  /** USD per 1,000 completion tokens. */
  outputUsdPer1k?: number;
}

export interface ModelCapabilities {
  modalities: string[];
  max_tokens?: number;
  tools?: boolean;
  streaming?: boolean;
}

/** A model row as stored. */
export interface CatalogRow {
  provider: string;
  model: string;
  capabilities: ModelCapabilities;
}

/** The currently-effective price for one model, or null when none has ever been recorded. */
export interface RateCardRow {
  provider: string;
  model: string;
  input_usd_per_1k: string;
  output_usd_per_1k: string;
}

/** What one provider's sync did, for the operator's summary line. */
export interface ProviderSyncResult {
  provider: ProviderId;
  /** Models the provider listed. */
  discovered: number;
  /** Rows inserted into `model_catalog`. */
  modelsAdded: number;
  /** Rows whose capabilities changed. */
  modelsUpdated: number;
  /** New rate-card versions written (a price that changed, or a first-ever price). */
  pricesChanged: number;
  /** Set when the provider could not be reached or refused; the run continues with the others. */
  error?: string;
}

export interface CatalogRepository {
  listForProvider(provider: string): Promise<CatalogRow[]>;
  upsertModel(provider: string, model: string, capabilities: ModelCapabilities): Promise<void>;
  currentPrices(provider: string): Promise<RateCardRow[]>;
  /** Close the open rate card (if any) and open a new one. A price change is a new VERSION. */
  replacePrice(
    provider: string,
    model: string,
    inputUsdPer1k: number,
    outputUsdPer1k: number,
  ): Promise<void>;
}

export interface CatalogService {
  /** Sync the named providers, or every provider with a usable models endpoint when omitted. */
  sync(providers?: readonly string[]): Promise<ProviderSyncResult[]>;
}
