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

/** One page of an org's audit trail, newest first. `before` is an exclusive seq cursor for paging
 * (omit for the first page). `limit` is bound so a caller can't request an unbounded scan. */
export function listAuditQuery(orgId: string, limit: number, before?: number): SqlQuery {
  const values: unknown[] = [orgId];
  let cursor = '';
  if (before !== undefined) {
    values.push(before);
    cursor = `AND seq < $${values.length}`;
  }
  values.push(limit);
  return {
    text: `SELECT id, seq, actor, action, target, encode(hash, 'hex') AS hash, created_at
             FROM audit_log
            WHERE org_id = $1 ${cursor}
            ORDER BY seq DESC
            LIMIT $${values.length}`,
    values,
  };
}

/** One org's full chain in append order (seq ASC) for verification. Selects the parsed jsonb payload
 * and the stored hash; `verifyChain` re-canonicalizes the payload to recompute each hash. */
export function readAuditChainQuery(orgId: string): SqlQuery {
  return {
    text: `SELECT seq, canonical_json, hash
             FROM audit_log
            WHERE org_id = $1
            ORDER BY seq ASC`,
    values: [orgId],
  };
}

/** Distinct orgs that have any audit rows — the work-list for `relay audit verify` (all orgs). */
export function listAuditOrgsQuery(): SqlQuery {
  return { text: `SELECT DISTINCT org_id FROM audit_log ORDER BY org_id`, values: [] };
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
