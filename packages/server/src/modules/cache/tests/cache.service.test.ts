import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { createCacheService } from '../services/cache.service.js';
import type { CachedCompletion } from '../types/cache.types.js';

const entry: CachedCompletion = {
  body: { id: 'x' },
  content: 'hi',
  usage: { inputTokens: 1, outputTokens: 2 },
};

// Expose the mock fns as standalone references so assertions never touch an unbound method.
function fakeClient(store: Map<string, string> = new Map()) {
  const set = vi.fn(async (k: string, v: string) => {
    store.set(k, v);
    return 'OK';
  });
  const get = vi.fn(async (k: string) => store.get(k) ?? null);
  return { client: { get, set } as unknown as Redis, get, set };
}

describe('cache service', () => {
  it('is a no-op when no Valkey client is present (offline OpenAPI mode)', async () => {
    const svc = createCacheService({ ttlSeconds: 60, maxBytes: 1000 });
    await svc.set('k', entry);
    expect(await svc.get('k')).toBeNull();
  });

  it('is a no-op when the TTL is 0 (cache disabled)', async () => {
    const { client, set } = fakeClient();
    const svc = createCacheService({ client, ttlSeconds: 0, maxBytes: 1000 });
    await svc.set('k', entry);
    expect(set).not.toHaveBeenCalled();
    expect(await svc.get('k')).toBeNull();
  });

  it('round-trips an entry through Valkey with the configured TTL', async () => {
    const { client, set } = fakeClient();
    const svc = createCacheService({ client, ttlSeconds: 42, maxBytes: 10_000 });
    await svc.set('c:org:hash', entry);
    expect(set).toHaveBeenCalledWith('c:org:hash', JSON.stringify(entry), 'EX', 42);
    expect(await svc.get('c:org:hash')).toEqual(entry);
  });

  it('does not cache a response larger than the byte cap', async () => {
    const { client, set } = fakeClient();
    const svc = createCacheService({ client, ttlSeconds: 60, maxBytes: 10 });
    await svc.set('k', entry); // serialized entry >> 10 bytes
    expect(set).not.toHaveBeenCalled();
  });

  it('treats a corrupt entry as a miss', async () => {
    const store = new Map([['k', 'not json']]);
    const svc = createCacheService({
      client: fakeClient(store).client,
      ttlSeconds: 60,
      maxBytes: 1000,
    });
    expect(await svc.get('k')).toBeNull();
  });
});
