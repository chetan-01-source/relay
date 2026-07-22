/**
 * Cache integration (Week 3 Day 11) — exercises the service against a REAL Valkey so the SET/GET +
 * TTL path is proven, not just the fake. Self-skips unless RELAY_VALKEY_URL is set.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { createCacheService } from '../services/cache.service.js';
import type { CachedCompletion } from '../types/cache.types.js';

const valkeyUrl = process.env.RELAY_VALKEY_URL;
const entry: CachedCompletion = {
  body: { id: 'x' },
  content: 'hello',
  usage: { inputTokens: 3, outputTokens: 4 },
};

describe.skipIf(!valkeyUrl)('cache integration (real Valkey)', () => {
  let client: Redis;

  beforeAll(async () => {
    client = new Redis(valkeyUrl!, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await client.connect();
  });
  afterAll(() => {
    client.disconnect();
  });

  it('stores and retrieves an entry within the TTL', async () => {
    const svc = createCacheService({ client, ttlSeconds: 30, maxBytes: 10_000 });
    const key = `c:it-${randomUUID()}:hash`;
    expect(await svc.get(key)).toBeNull(); // cold miss
    await svc.set(key, entry);
    expect(await svc.get(key)).toEqual(entry); // warm hit
    const ttl = await client.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
    await client.del(key);
  });
});
