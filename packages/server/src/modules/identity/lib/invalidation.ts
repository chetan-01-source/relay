/**
 * Snapshot-invalidation message contract (Week 2 Day 6 · ADR snapshot + pub/sub). Every worker
 * subscribes to the invalidation channels; the publisher (key revoke lands Day 8, org suspend Day 7)
 * emits an entity id plus the publish timestamp. The timestamp lets each subscriber observe the
 * propagation lag into `relay_snapshot_invalidation_lag` — how we prove the ≤1s revocation SLA.
 */
import type { EventBus } from '../../../platform/eventbus.js';

export interface InvalidationMessage {
  id: string; // key_id or org_id, depending on the channel
  ts?: number; // epoch ms at publish; absent for a bare-id message
}

/** Valkey pub/sub channels the resolver listens on. */
export const CH_KEY_INVALIDATE = 'key.invalidate';
export const CH_ORG_SUSPEND = 'org.suspend';
export const CH_ORG_FEATURES = 'org.features.updated';

export function encodeInvalidation(id: string): string {
  return JSON.stringify({ id, ts: Date.now() });
}

/** Parse a message; tolerates a bare id string (no timestamp → no lag observation). */
export function decodeInvalidation(msg: string): InvalidationMessage {
  try {
    const parsed = JSON.parse(msg) as InvalidationMessage;
    if (parsed && typeof parsed.id === 'string') {
      return typeof parsed.ts === 'number' ? { id: parsed.id, ts: parsed.ts } : { id: parsed.id };
    }
  } catch {
    // not JSON — fall through and treat the whole message as the id
  }
  return { id: msg };
}

// ── Publishers ───────────────────────────────────────────────────────────────
// The write side of the invalidation contract. Other modules (tenancy suspends an org, apps revoke a
// key) call these so every worker's in-process snapshot drops the stale entry within ≤1s. Kept next
// to the channel constants + codec so the publish and subscribe halves cannot drift.

/** Drop a single virtual key from every worker's snapshot (revoke / rotate). */
export function publishKeyInvalidation(bus: EventBus, keyId: string): Promise<number> {
  return bus.publish(CH_KEY_INVALIDATE, encodeInvalidation(keyId));
}

/** Clear cached snapshots for a suspended org so the data plane rejects its keys immediately. */
export function publishOrgSuspend(bus: EventBus, orgId: string): Promise<number> {
  return bus.publish(CH_ORG_SUSPEND, encodeInvalidation(orgId));
}

/** Signal that an org's entitlements changed so snapshots reload them. */
export function publishOrgFeaturesUpdated(bus: EventBus, orgId: string): Promise<number> {
  return bus.publish(CH_ORG_FEATURES, encodeInvalidation(orgId));
}
