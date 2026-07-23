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

/** A row of the list surface (GET /api/v1/audit). `hash` is hex for transparency; bigint seq is a
 * string from pg, `created_at` a timestamptz string. */
export interface AuditListRow {
  id: string;
  seq: string;
  actor: string;
  action: string;
  target: string | null;
  hash: string;
  created_at: string;
}

/** A chain row read for verification. `canonical_json` is the parsed jsonb payload; `hash` the bytea. */
export interface AuditChainRow {
  seq: string;
  canonical_json: unknown;
  hash: Buffer;
}

/** The API shape of one audit record in a list response. */
export interface AuditRecordView {
  object: 'audit.record';
  id: string;
  seq: number;
  actor: string;
  action: string;
  target: string | null;
  hash: string;
  created_at: string;
}

/** Options for a list page. `limit` is clamped by the service; `before` is an exclusive seq cursor. */
export interface AuditListOptions {
  limit: number;
  before?: number;
}

/** Result of verifying one org's chain. */
export interface AuditVerifyResult {
  orgId: string;
  count: number;
  valid: boolean;
  brokenAtSeq?: number;
}

/**
 * The append side of the trail — the ONLY surface control-plane mutations (apps/providers/tenancy)
 * depend on. Kept minimal (interface segregation) so an append-only caller never has to fake the
 * read/verify methods it does not use.
 */
export interface AuditRepository {
  /**
   * Append one event to an org's chain within the caller's transaction. Serializes per-org via an
   * advisory lock so concurrent appends get contiguous sequence numbers and a consistent prev_hash.
   */
  appendWithTx(tx: Queryable, orgId: string, event: AuditEventInput): Promise<AuditRecord>;
}

/** The read/verify side (Day 12) — consumed only by the audit service and CLI. */
export interface AuditReadRepository {
  /** One page of an org's trail, newest first (run inside the org's tenant transaction). */
  listWithTx(tx: Queryable, orgId: string, opts: AuditListOptions): Promise<AuditListRow[]>;
  /** An org's full chain in append order, for verification. */
  readChainWithTx(tx: Queryable, orgId: string): Promise<AuditChainRow[]>;
  /** Distinct orgs with audit rows — the work-list for `relay audit verify`. */
  listOrgsWithTx(tx: Queryable): Promise<string[]>;
}

/** Business boundary for the read/verify surface. Opens the tenant transaction; no SQL, no HTTP. */
export interface AuditService {
  /** One page of the caller org's audit trail, mapped to API records. */
  list(orgId: string, opts: AuditListOptions): Promise<AuditRecordView[]>;
  /** Verify one org's hash chain. */
  verify(orgId: string): Promise<AuditVerifyResult>;
  /** Verify every org's chain (used by the CLI). */
  verifyAll(): Promise<AuditVerifyResult[]>;
}
