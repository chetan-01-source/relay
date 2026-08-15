/**
 * Catalog SQL — the ONLY file in this module containing query text. Every export returns a
 * parametrized SqlQuery; provider and model ids come from an upstream HTTP response, so binding them
 * as $-params is not a formality — it is the boundary that keeps a hostile provider response from
 * reaching the planner as SQL.
 *
 * `model_catalog` and `rate_cards` are GLOBAL (no org_id), so these run outside `withTenant`.
 */
import type { SqlQuery } from '../../../platform/db.js';

/** Every catalogued model for one provider. */
export function listForProviderQuery(provider: string): SqlQuery {
  return {
    text: `SELECT provider, model, capabilities FROM model_catalog WHERE provider = $1 ORDER BY model`,
    values: [provider],
  };
}

/** Insert or refresh one model's capabilities. Idempotent, so a re-sync writes nothing new. */
export function upsertModelQuery(provider: string, model: string, capabilities: unknown): SqlQuery {
  return {
    text: `INSERT INTO model_catalog (provider, model, capabilities)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (provider, model) DO UPDATE SET capabilities = EXCLUDED.capabilities`,
    values: [provider, model, JSON.stringify(capabilities)],
  };
}

/**
 * The currently-effective price per model for one provider. `effective_to IS NULL` is the open
 * version; `DISTINCT ON` guards against a row set where more than one is somehow open, always
 * preferring the newest.
 */
export function currentPricesQuery(provider: string): SqlQuery {
  return {
    text: `SELECT DISTINCT ON (model) provider, model, input_usd_per_1k, output_usd_per_1k
             FROM rate_cards
            WHERE provider = $1 AND effective_to IS NULL
         ORDER BY model, effective_from DESC`,
    values: [provider],
  };
}

/**
 * Close the open rate card for one model. Pricing is versioned rather than overwritten, so a usage
 * event settled last week can still be explained by the price that was effective when it ran —
 * an UPDATE in place would silently rewrite billing history.
 */
export function closePriceQuery(provider: string, model: string): SqlQuery {
  return {
    text: `UPDATE rate_cards SET effective_to = now()
            WHERE provider = $1 AND model = $2 AND effective_to IS NULL`,
    values: [provider, model],
  };
}

/** Open a new rate card, effective now. */
export function insertPriceQuery(
  provider: string,
  model: string,
  inputUsdPer1k: number,
  outputUsdPer1k: number,
): SqlQuery {
  return {
    text: `INSERT INTO rate_cards (provider, model, input_usd_per_1k, output_usd_per_1k)
           VALUES ($1, $2, $3, $4)`,
    values: [provider, model, inputUsdPer1k, outputUsdPer1k],
  };
}

/**
 * One sealed credential per provider, for syncing that provider's catalog with the operator's own
 * key. Newest first, so a freshly-added credential wins over one that may have been rotated out.
 *
 * Deliberately NOT tenant-scoped: `relay sync-models` is an operator command run by the migration
 * role, and the catalog it fills is global. This is why the calling service refuses to run it in the
 * cloud edition — there, "some tenant's key" is the wrong authority for a table every tenant reads.
 */
export function listSyncCredentialsQuery(): SqlQuery {
  return {
    text: `SELECT DISTINCT ON (provider)
                  provider, base_url, ciphertext, iv, auth_tag, wrapped_dek
             FROM provider_credentials
            WHERE status = 'active'
         ORDER BY provider, created_at DESC`,
    values: [],
  };
}
