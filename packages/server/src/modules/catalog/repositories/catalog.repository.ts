/**
 * Catalog repository — executes the parametrized queries from catalog.queries.ts against an injected
 * Queryable. No query text, no business logic.
 */
import type { Database } from '../../../platform/db.js';
import {
  closePriceQuery,
  listReferencePricesQuery,
  listSyncCredentialsQuery,
  currentPricesQuery,
  insertPriceQuery,
  listForProviderQuery,
  upsertModelQuery,
} from '../queries/catalog.queries.js';
import type {
  CatalogRepository,
  CatalogRow,
  ModelCapabilities,
  RateCardRow,
  SyncCredentialRow,
} from '../types/catalog.types.js';

// Takes the full Database, not a bare Queryable: `replacePrice` needs a transaction, and the global
// tables it writes are outside RLS so `withTenant` is the wrong tool.
export function createCatalogRepository(db: Database): CatalogRepository {
  return {
    listReferencePrices(referenceProvider) {
      return db.run<RateCardRow>(listReferencePricesQuery(referenceProvider));
    },
    listSyncCredentials() {
      return db.run<SyncCredentialRow>(listSyncCredentialsQuery());
    },
    listForProvider(provider) {
      return db.run<CatalogRow>(listForProviderQuery(provider));
    },

    async upsertModel(provider: string, model: string, capabilities: ModelCapabilities) {
      await db.run(upsertModelQuery(provider, model, capabilities));
    },

    currentPrices(provider) {
      return db.run<RateCardRow>(currentPricesQuery(provider));
    },

    // Close-then-insert is two statements maintaining one invariant — exactly one open rate card per
    // (provider, model) — so it must be atomic. Without the transaction a crash between them leaves
    // the model with NO effective price, and every request through it settles at zero cost.
    async replacePrice(provider, model, inputUsdPer1k, outputUsdPer1k) {
      await db.transaction(async (tx) => {
        await tx.run(closePriceQuery(provider, model));
        await tx.run(insertPriceQuery(provider, model, inputUsdPer1k, outputUsdPer1k));
      });
    },
  };
}
