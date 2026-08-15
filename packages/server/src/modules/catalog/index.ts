/**
 * Catalog module — DI wiring. A LIBRARY module: it has no HTTP surface, because refreshing the
 * global model catalog is an operator action (`relay sync-models`), not something a tenant request
 * should be able to trigger against a dozen third-party APIs.
 */
import type { Database } from '../../platform/db.js';
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
