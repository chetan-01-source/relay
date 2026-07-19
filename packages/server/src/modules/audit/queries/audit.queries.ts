/**
 * Audit SQL — the ONLY file in this module with query text. Every value is bound as a $-param
 * (never interpolated), so these statements are injection-safe by construction (DEVELOPMENT.md §3.4).
 */
import type { SqlQuery } from '../../../platform/db.js';

/**
 * Serialize appends for one org within the current transaction. A transaction-scoped advisory lock
 * (released automatically on COMMIT/ROLLBACK) means two concurrent appends can't read the same tail
 * and collide on the UNIQUE(org_id, seq) constraint. hashtext() maps the org id to the lock's key.
 */
export function lockOrgAuditChainQuery(orgId: string): SqlQuery {
  return { text: `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, values: [orgId] };
}

/** The current tail of an org's chain (its highest seq + that row's hash), or no rows if empty. */
export function getAuditTailQuery(orgId: string): SqlQuery {
  return {
    text: `SELECT seq, hash FROM audit_log WHERE org_id = $1 ORDER BY seq DESC LIMIT 1`,
    values: [orgId],
  };
}

/** Append one chained row. canonical_json is stored as jsonb; the hash was computed over its
 * canonical (sorted-key) serialization so Day-12 verify can recompute it deterministically. */
export function insertAuditQuery(input: {
  orgId: string;
  seq: number;
  actor: string;
  action: string;
  target: string | null;
  canonicalJson: string;
  prevHash: Buffer | null;
  hash: Buffer;
}): SqlQuery {
  return {
    text: `INSERT INTO audit_log
             (org_id, seq, actor, action, target, canonical_json, prev_hash, hash)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
           RETURNING id`,
    values: [
      input.orgId,
      input.seq,
      input.actor,
      input.action,
      input.target,
      input.canonicalJson,
      input.prevHash,
      input.hash,
    ],
  };
}
