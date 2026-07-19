/**
 * Audit module interfaces (Week 2 Day 7 · schema 0008). A reusable, hash-chained append-only trail.
 * Control-plane mutations call `appendWithTx` inside their own transaction so the audit row commits
 * atomically with the change it records. The read/verify surface + CLI land with the Day 12 module.
 */
import type { Queryable } from '../../../platform/db.js';

/** What a caller supplies to record one event. */
export interface AuditEventInput {
  actor: string; // logto user id, a virtual key id, or 'system'
  action: string; // dotted verb, e.g. 'org.create' / 'org.suspend' / 'org.features.updated'
  target?: string; // affected resource id (defaults to null)
  data?: Record<string, unknown>; // event-specific payload, folded into the canonical hash
}

/** The persisted, chained record (subset returned to callers). */
export interface AuditRecord {
  id: string;
  orgId: string;
  seq: number;
  actor: string;
  action: string;
  target: string | null;
  hash: Buffer;
}

/** Row shape read back for chaining (bigint seq arrives as a string from pg). */
export interface AuditTailRow {
  seq: string;
  hash: Buffer;
}

export interface AuditRepository {
  /**
   * Append one event to an org's chain within the caller's transaction. Serializes per-org via an
   * advisory lock so concurrent appends get contiguous sequence numbers and a consistent prev_hash.
   */
  appendWithTx(tx: Queryable, orgId: string, event: AuditEventInput): Promise<AuditRecord>;
}
