import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mintVirtualKey, parseVirtualKey } from '../../../platform/crypto.js';
import type { EventBus } from '../../../platform/eventbus.js';
import { createLruCache } from '../lib/snapshot-cache.js';
import { encodeInvalidation, CH_KEY_INVALIDATE, CH_ORG_SUSPEND } from '../lib/invalidation.js';
import { createVirtualKeyResolver } from '../services/resolver.js';
import type {
  IdentityRepository,
  VirtualKeyRow,
  VirtualKeySnapshot,
} from '../types/identity.types.js';

const master = randomBytes(32).toString('base64');

/** A fake repository backed by an in-memory map keyed by key_id. Counts reads to prove caching. */
function fakeRepo(rows: Record<string, VirtualKeyRow>) {
  const reads = { count: 0 };
  const repo: IdentityRepository = {
    resolveByKeyId(keyId) {
      reads.count += 1;
      const row = rows[keyId];
      return Promise.resolve(
        row
          ? {
              row,
              entitlements: { 'cache.exact': true },
              policy: {
                rateLimit: { rpm: 60, tpm: 1000 },
                budget: { period: 'monthly', limitUsd: 25, hardCutoff: true },
              },
            }
          : null,
      );
    },
  };
  return { repo, reads };
}

/** A fake bus capturing subscription handlers so tests can drive invalidation messages. */
function fakeBus() {
  const handlers = new Map<string, (msg: string) => void>();
  const bus = {
    subscribe: (channel: string, handler: (msg: string) => void) => {
      handlers.set(channel, handler);
      return Promise.resolve();
    },
  } as unknown as EventBus;
  return { bus, handlers };
}

function rowFor(keyId: string, verifier: Buffer, over: Partial<VirtualKeyRow> = {}): VirtualKeyRow {
  return {
    id: 'vk-1',
    org_id: 'org-1',
    app_id: 'app-1',
    key_id: keyId,
    key_sha256: verifier,
    environment: 'live',
    status: 'active',
    grace_until: null,
    revoked_at: null,
    org_status: 'active',
    ...over,
  };
}

describe('virtual-key resolver', () => {
  let minted: ReturnType<typeof mintVirtualKey>;
  let keyId: string;

  beforeEach(() => {
    minted = mintVirtualKey(master, 'live');
    keyId = minted.keyId;
  });

  it('resolves a valid key to a snapshot and caches it (one DB read for repeat calls)', async () => {
    const { repo, reads } = fakeRepo({ [keyId]: rowFor(keyId, minted.secretVerifier) });
    const resolver = createVirtualKeyResolver({
      repo,
      cache: createLruCache<VirtualKeySnapshot>(),
      masterKey: master,
    });

    const first = await resolver.resolve(minted.plaintext);
    const second = await resolver.resolve(minted.plaintext);

    expect(first?.orgId).toBe('org-1');
    expect(first?.appId).toBe('app-1');
    expect(first?.entitlements).toEqual({ 'cache.exact': true });
    expect(first?.policy).toEqual({
      rateLimit: { rpm: 60, tpm: 1000 },
      budget: { period: 'monthly', limitUsd: 25, hardCutoff: true },
    });
    expect(second).toEqual(first);
    expect(reads.count).toBe(1); // second call served from cache
  });

  it('returns null for a malformed key without touching the repo', async () => {
    const { repo, reads } = fakeRepo({});
    const resolver = createVirtualKeyResolver({
      repo,
      cache: createLruCache<VirtualKeySnapshot>(),
      masterKey: master,
    });
    expect(await resolver.resolve('not-a-key')).toBeNull();
    expect(reads.count).toBe(0);
  });

  it('returns null for an unknown selector', async () => {
    const { repo } = fakeRepo({});
    const resolver = createVirtualKeyResolver({
      repo,
      cache: createLruCache<VirtualKeySnapshot>(),
      masterKey: master,
    });
    expect(await resolver.resolve(minted.plaintext)).toBeNull();
  });

  it('rejects a valid selector with a wrong secret — and does not cache it', async () => {
    const { repo, reads } = fakeRepo({ [keyId]: rowFor(keyId, minted.secretVerifier) });
    const cache = createLruCache<VirtualKeySnapshot>();
    const resolver = createVirtualKeyResolver({ repo, cache, masterKey: master });
    const forged = `rk_live_${keyId}.${randomBytes(24).toString('base64url')}`;

    expect(await resolver.resolve(forged)).toBeNull();
    expect(cache.size).toBe(0);
    // a later correct call still resolves (the miss was not poisoned)
    expect((await resolver.resolve(minted.plaintext))?.orgId).toBe('org-1');
    expect(reads.count).toBe(2);
  });

  it('surfaces status so the caller can gate: revoked key / suspended org', async () => {
    const revoked = mintVirtualKey(master, 'live');
    const suspended = mintVirtualKey(master, 'live');
    const { repo } = fakeRepo({
      [revoked.keyId]: rowFor(revoked.keyId, revoked.secretVerifier, { status: 'revoked' }),
      [suspended.keyId]: rowFor(suspended.keyId, suspended.secretVerifier, {
        org_status: 'suspended',
      }),
    });
    const resolver = createVirtualKeyResolver({
      repo,
      cache: createLruCache<VirtualKeySnapshot>(),
      masterKey: master,
    });

    expect((await resolver.resolve(revoked.plaintext))?.keyStatus).toBe('revoked');
    expect((await resolver.resolve(suspended.plaintext))?.orgStatus).toBe('suspended');
  });

  it('drops a cached entry on a key.invalidate message and records the lag', async () => {
    const { repo, reads } = fakeRepo({ [keyId]: rowFor(keyId, minted.secretVerifier) });
    const cache = createLruCache<VirtualKeySnapshot>();
    const { bus, handlers } = fakeBus();
    const resolver = createVirtualKeyResolver({ repo, cache, masterKey: master, bus });
    await resolver.start();

    await resolver.resolve(minted.plaintext); // populate cache (read #1)
    handlers.get(CH_KEY_INVALIDATE)!(encodeInvalidation(keyId)); // bus drop
    await resolver.resolve(minted.plaintext); // must re-read (read #2)

    expect(reads.count).toBe(2);
  });

  it('clears the whole cache on an org.suspend message', async () => {
    const { repo } = fakeRepo({ [keyId]: rowFor(keyId, minted.secretVerifier) });
    const cache = createLruCache<VirtualKeySnapshot>();
    const { bus, handlers } = fakeBus();
    const resolver = createVirtualKeyResolver({ repo, cache, masterKey: master, bus });
    await resolver.start();

    await resolver.resolve(minted.plaintext);
    expect(cache.size).toBe(1);
    handlers.get(CH_ORG_SUSPEND)!(encodeInvalidation('org-1'));
    expect(cache.size).toBe(0);
  });

  it('invalidate() drops a single entry locally', async () => {
    const { repo } = fakeRepo({ [keyId]: rowFor(keyId, minted.secretVerifier) });
    const cache = createLruCache<VirtualKeySnapshot>();
    const resolver = createVirtualKeyResolver({ repo, cache, masterKey: master });
    await resolver.resolve(minted.plaintext);
    resolver.invalidate(parseVirtualKey(minted.plaintext)!.keyId);
    expect(cache.size).toBe(0);
  });
});
