import { describe, it, expect } from 'vitest';
import { createCacheService } from '../services/cache.service.js';
import type { Redis } from 'ioredis';

/**
 * The cache has THREE independent switches, and all three must be on for a response to be stored:
 *
 *   1. `RELAY_CACHE_TTL_S` — the deployment-wide master switch, enforced here in the service.
 *   2. `routes.cache_enabled` — the per-route toggle the console writes, enforced in the proxy on the
 *      WRITE path (a route that never stores can never be served from cache).
 *   3. the `cache.exact` entitlement — enforced in the proxy on both paths.
 *
 * (1) shipped as `0`, which meant nothing was ever cached no matter what the other two said, and
 * (2) and (3) were not read by the data plane at all. These tests pin the master switch; the proxy
 * tests cover the other two.
 */
function fakeRedis() {
  const store = new Map<string, string>();
  const calls = { get: 0, set: 0 };
  const client = {
    get: (key: string) => {
      calls.get += 1;
      return Promise.resolve(store.get(key) ?? null);
    },
    set: (key: string, value: string) => {
      calls.set += 1;
      store.set(key, value);
      return Promise.resolve('OK');
    },
  } as unknown as Redis;
  return { client, calls, store };
}

const entry = { body: { id: 'x' }, content: 'hello' };

describe('cache master switch (RELAY_CACHE_TTL_S)', () => {
  it('stores and serves when the TTL is positive', async () => {
    const { client, store } = fakeRedis();
    const cache = createCacheService({ client, ttlSeconds: 300, maxBytes: 1_000_000 });
    await cache.set('k', entry);
    expect(store.size).toBe(1);
    await expect(cache.get('k')).resolves.toMatchObject({ content: 'hello' });
  });

  // This is the shipped default, and the whole reason the cache appeared broken.
  it('is a total no-op at ttl 0 — never reads, never writes', async () => {
    const { client, calls } = fakeRedis();
    const cache = createCacheService({ client, ttlSeconds: 0, maxBytes: 1_000_000 });
    await cache.set('k', entry);
    expect(await cache.get('k')).toBeNull();
    expect(calls.set).toBe(0);
    expect(calls.get).toBe(0);
  });

  it('is disabled without a Valkey client (offline spec dump)', async () => {
    const cache = createCacheService({ ttlSeconds: 300, maxBytes: 1_000_000 });
    await cache.set('k', entry);
    expect(await cache.get('k')).toBeNull();
  });

  it('refuses to store a body over the size cap rather than buffering it', async () => {
    const { client, calls } = fakeRedis();
    const cache = createCacheService({ client, ttlSeconds: 300, maxBytes: 10 });
    await cache.set('k', { body: { big: 'x'.repeat(5000) }, content: 'x' });
    expect(calls.set).toBe(0);
  });

  it('treats a corrupt entry as a miss, never a 500', async () => {
    const { client, store } = fakeRedis();
    store.set('k', '{not json');
    const cache = createCacheService({ client, ttlSeconds: 300, maxBytes: 1_000_000 });
    await expect(cache.get('k')).resolves.toBeNull();
  });
});
