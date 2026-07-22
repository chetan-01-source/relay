/**
 * Cache module public face (dependency-cruiser: only index.ts is cross-importable). A library module
 * (no HTTP surface) injected into the proxy, mirroring routing/policy. Valkey only — no Postgres.
 */
export { createCacheService, type CacheServiceDeps } from './services/cache.service.js';
export { cacheKeyFor } from './lib/cache-key.js';
export type { CacheService, CachedCompletion } from './types/cache.types.js';
