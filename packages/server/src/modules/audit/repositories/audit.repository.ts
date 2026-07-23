/**
 * Audit repository (Week 2 Day 7) — data access for the append-only, hash-chained trail. It runs the
 * parametrized queries and composes the pure hash-chain lib; it holds no query text and no business
 * decision beyond chaining integrity (which is intrinsic to how a tamper-evident row is stored).
 *
 * `appendWithTx` takes the caller's transaction (a Queryable) so the audit row commits atomically
 * with the change it records — never a half-recorded mutation.
 */
import { canonicalize, computeAuditHash } from '../lib/hash-chain.js';
import {
  lockOrgAuditChainQuery,
  getAuditTailQuery,
  insertAuditQuery,
  listAuditQuery,
  readAuditChainQuery,
  listAuditOrgsQuery,
} from '../queries/audit.queries.js';
import type {
  AuditChainRow,
  AuditListRow,
  AuditReadRepository,
  AuditRepository,
  AuditTailRow,
} from '../types/audit.types.js';

export function createAuditRepository(): AuditRepository & AuditReadRepository {
  return {
    listWithTx(tx, orgId, opts) {
      return tx.run<AuditListRow>(listAuditQuery(orgId, opts.limit, opts.before));
    },

    readChainWithTx(tx, orgId) {
      return tx.run<AuditChainRow>(readAuditChainQuery(orgId));
    },

    async listOrgsWithTx(tx) {
      const rows = await tx.run<{ org_id: string }>(listAuditOrgsQuery());
      return rows.map((r) => r.org_id);
    },

    async appendWithTx(tx, orgId, event) {
      // Serialize per-org appends so concurrent writers get contiguous seq + a stable prev_hash.
      await tx.run(lockOrgAuditChainQuery(orgId));

      const tail = (await tx.run<AuditTailRow>(getAuditTailQuery(orgId)))[0];
      const seq = (tail ? Number(tail.seq) : 0) + 1; // pg returns bigint as a string
      const prevHash = tail ? tail.hash : null;

      // Bind seq into the hashed content so a reordering attack also breaks the chain.
      const canonicalJson = canonicalize({
        seq,
        actor: event.actor,
        action: event.action,
        target: event.target ?? null,
        data: event.data ?? {},
      });
      const hash = computeAuditHash(prevHash, canonicalJson);

      const rows = await tx.run<{ id: string }>(
        insertAuditQuery({
          orgId,
          seq,
          actor: event.actor,
          action: event.action,
          target: event.target ?? null,
          canonicalJson,
          prevHash,
          hash,
        }),
      );

      return {
        id: rows[0]!.id,
        orgId,
        seq,
        actor: event.actor,
        action: event.action,
        target: event.target ?? null,
        hash,
      };
    },
  };
}
