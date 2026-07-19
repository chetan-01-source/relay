/**
 * Snapshot-invalidation message contract (Week 2 Day 6 · ADR snapshot + pub/sub). Every worker
 * subscribes to the invalidation channels; the publisher (key revoke lands Day 8, org suspend Day 7)
 * emits an entity id plus the publish timestamp. The timestamp lets each subscriber observe the
 * propagation lag into `relay_snapshot_invalidation_lag` — how we prove the ≤1s revocation SLA.
 */
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
