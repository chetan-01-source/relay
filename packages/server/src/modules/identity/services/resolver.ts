/**
 * Virtual-key resolver (Week 2 Day 6 · ADR virtual-key-format + ADR snapshot). Turns a presented
 * `rk_<env>_<keyId>.<secret>` into an immutable snapshot:
 *
 *   parse → cache hit? return (no hashing)      ← steady state, ≤1µs, no Postgres
 *         → miss: 1 platform-scoped read by key_id → verify the secret ONCE (timing-safe) → cache
 *
 * Invalidation is push, not TTL: workers subscribe to Valkey channels and drop entries within ≤1s
 * (metric relay_snapshot_invalidation_lag). Status is NEVER gated here — a found key is returned
 * with its status so the preHandler can distinguish 401 (revoked/unknown) from 403 (suspended org).
 */
import { parseVirtualKey, verifyVirtualKeySecret } from '../../../platform/crypto.js';
import type { EventBus } from '../../../platform/eventbus.js';
import { snapshotInvalidationLag } from '../../../platform/metrics.js';
import type { SnapshotCache } from '../lib/snapshot-cache.js';
import {
  CH_KEY_INVALIDATE,
  CH_ORG_SUSPEND,
  CH_ORG_FEATURES,
  decodeInvalidation,
} from '../lib/invalidation.js';
import type {
  IdentityRepository,
  VirtualKeyResolver,
  VirtualKeyRow,
  VirtualKeySnapshot,
} from '../types/identity.types.js';

export interface ResolverDeps {
  repo: IdentityRepository;
  cache: SnapshotCache<VirtualKeySnapshot>;
  bus?: EventBus; // absent for the offline `relay openapi` dump (no Valkey); start() is then a no-op
  masterKey: string;
}

export function createVirtualKeyResolver(deps: ResolverDeps): VirtualKeyResolver {
  const { repo, cache, bus, masterKey } = deps;

  async function resolve(plaintext: string): Promise<VirtualKeySnapshot | null> {
    const parsed = parseVirtualKey(plaintext);
    if (!parsed) return null;

    const cached = cache.get(parsed.keyId);
    if (cached) return cached;

    const found = await repo.resolveByKeyId(parsed.keyId);
    if (!found) return null;

    // Verify the SECRET half exactly once, timing-safe. A valid keyId with a wrong secret must not
    // resolve — and must not be cached, so it cannot poison a later correct lookup.
    if (!verifyVirtualKeySecret(masterKey, parsed.secret, found.row.key_sha256)) return null;

    const snapshot = toSnapshot(found.row, found.entitlements);
    cache.set(parsed.keyId, snapshot);
    return snapshot;
  }

  function invalidate(keyId: string): void {
    cache.delete(keyId);
  }

  // Each handler drops the stale entry, then — if the publisher stamped a timestamp — records how
  // long the message took to propagate here. Org-level events clear the whole cache: snapshots are
  // not indexed by org and these events are rare, so a full clear is simpler than a reverse index.
  function onMessage(drop: (id: string) => void) {
    return (raw: string): void => {
      const { id, ts } = decodeInvalidation(raw);
      drop(id);
      if (ts !== undefined) snapshotInvalidationLag.observe(Math.max(0, (Date.now() - ts) / 1000));
    };
  }

  async function start(): Promise<void> {
    if (!bus) return; // offline (spec dump) — nothing to subscribe to
    await bus.subscribe(
      CH_KEY_INVALIDATE,
      onMessage((id) => cache.delete(id)),
    );
    await bus.subscribe(
      CH_ORG_SUSPEND,
      onMessage(() => cache.clear()),
    );
    await bus.subscribe(
      CH_ORG_FEATURES,
      onMessage(() => cache.clear()),
    );
  }

  return { resolve, invalidate, start };
}

function toSnapshot(row: VirtualKeyRow, entitlements: Record<string, unknown>): VirtualKeySnapshot {
  return {
    virtualKeyId: row.id,
    keyId: row.key_id,
    orgId: row.org_id,
    appId: row.app_id,
    environment: row.environment,
    orgStatus: row.org_status,
    keyStatus: row.status,
    entitlements,
    policy: {}, // reserved for Day 10 (rate limits + budgets)
  };
}
