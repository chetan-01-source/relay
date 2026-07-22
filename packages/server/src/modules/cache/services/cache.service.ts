/**
 * Cache service (Week 3 Day 11) — Valkey-backed exact-match cache. Business logic only; the key
 * derivation lives in lib/. If Valkey is absent (offline `relay openapi` dump) or the TTL is 0, the
 * cache is disabled and every call is a safe no-op — the gateway behaves exactly as before.
 */
import type { Redis } from 'ioredis';
import { cacheKeyFor } from '../lib/cache-key.js';
import type { CacheService, CachedCompletion } from '../types/cache.types.js';

export interface CacheServiceDeps {
  client?: Redis; // Valkey command client (reused from the event bus); absent → cache disabled
  ttlSeconds: number; // per-entry TTL; <= 0 disables caching entirely
  maxBytes: number; // tee-within-cap: responses larger than this are never cached
}

export function createCacheService(deps: CacheServiceDeps): CacheService {
  const client = deps.client;
  const enabled = Boolean(client) && deps.ttlSeconds > 0;

  return {
    keyFor: (orgId, req) => cacheKeyFor(orgId, req),

    async get(key) {
      if (!enabled) return null;
      const raw = await client!.get(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as CachedCompletion;
      } catch {
        return null; // a corrupt entry is treated as a miss, never a 500
      }
    },

    async set(key, value) {
      if (!enabled) return;
      const raw = JSON.stringify(value);
      // Never buffer/store an unbounded body — oversized responses simply aren't cached.
      if (Buffer.byteLength(raw) > deps.maxBytes) return;
      await client!.set(key, raw, 'EX', deps.ttlSeconds);
    },
  };
}
