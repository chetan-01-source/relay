/**
 * Catalog module — DI wiring. A LIBRARY module: it has no HTTP surface, because refreshing the
 * global model catalog is an operator action (`relay sync-models`), not something a tenant request
 * should be able to trigger against a dozen third-party APIs.
 */
import type { Database } from '../../platform/db.js';
import { openCredential } from '../../platform/crypto.js';
import { createCatalogRepository } from './repositories/catalog.repository.js';
import { createCatalogService, type CatalogServiceDeps } from './services/catalog.service.js';
import type { CatalogService } from './types/catalog.types.js';

export type { CatalogService, ProviderSyncResult } from './types/catalog.types.js';
export { envKeyName } from './services/catalog.service.js';

export function createCatalog(
  db: Database,
  overrides: Omit<CatalogServiceDeps, 'repo'> = {},
): CatalogService {
  return createCatalogService({ repo: createCatalogRepository(db), ...overrides });
}

export interface StoredCredentialSyncOptions {
  /** `RELAY_MASTER_KEY` — needed to unseal the stored provider keys. */
  masterKey: string;
  /** The deployment's edition. Stored credentials are used ONLY in `oss`. */
  edition: 'oss' | 'cloud';
}

/**
 * A catalog service that may sync using the operator's OWN stored provider credentials.
 *
 * Gated on the edition rather than offered as a flag: in a self-hosted deployment the person who
 * saved the OpenAI key and the person running `relay sync-models` are the same person, so requiring
 * them to also export RELAY_SYNC_KEY_OPENAI is friction with no security value. In a cloud
 * deployment those are different people, and populating a table every tenant reads with one
 * tenant's key would let that tenant's entitlements decide what everyone else may route to.
 */
export function createCatalogWithStoredCredentials(
  db: Database,
  options: StoredCredentialSyncOptions,
  overrides: Omit<CatalogServiceDeps, 'repo'> = {},
): CatalogService {
  if (options.edition !== 'oss') return createCatalog(db, overrides);
  return createCatalog(db, {
    openCredential: (row) =>
      openCredential(options.masterKey, {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
        wrappedDek: row.wrapped_dek,
      }),
    ...overrides,
  });
}
