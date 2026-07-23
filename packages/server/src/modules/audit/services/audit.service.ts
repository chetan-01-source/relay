/**
 * Audit service (Week 3 Day 12) — business logic for the read/verify surface. Opens the tenant
 * transaction so RLS scopes reads to one org, maps rows to API records, and re-walks the hash chain
 * with the pure `verifyChain` lib. No SQL, no HTTP — depends only on the Database handle and the
 * AuditRepository interface, so it is unit-testable with fakes.
 */
import type { Database } from '../../../platform/db.js';
import { verifyChain, type AuditChainEntry } from '../lib/hash-chain.js';
import type {
  AuditListOptions,
  AuditListRow,
  AuditReadRepository,
  AuditRecordView,
  AuditService,
  AuditVerifyResult,
} from '../types/audit.types.js';

/** Nil UUID for the platform-admin transaction that lists every org's chain (verifyAll). The
 * `platform_admin_access` RLS policy grants cross-org visibility regardless of current_org. */
const PLATFORM_ADMIN_ORG = '00000000-0000-0000-0000-000000000000';

/** Hard ceiling on a list page so a caller can never trigger an unbounded scan. */
const MAX_LIMIT = 200;

function toView(row: AuditListRow): AuditRecordView {
  return {
    object: 'audit.record',
    id: row.id,
    seq: Number(row.seq), // pg returns bigint as a string
    actor: row.actor,
    action: row.action,
    target: row.target,
    hash: row.hash,
    created_at: row.created_at,
  };
}

export interface AuditServiceDeps {
  db: Database;
  repo: AuditReadRepository;
}

export function createAuditService(deps: AuditServiceDeps): AuditService {
  async function verifyOrg(orgId: string): Promise<AuditVerifyResult> {
    const rows = await deps.db.withTenant(orgId, { isPlatformAdmin: true }, (tx) =>
      deps.repo.readChainWithTx(tx, orgId),
    );
    const entries: AuditChainEntry[] = rows.map((r) => ({
      seq: Number(r.seq),
      canonicalJson: r.canonical_json,
      hash: r.hash,
    }));
    const result = verifyChain(entries);
    return {
      orgId,
      count: result.count,
      valid: result.valid,
      ...(result.brokenAtSeq !== undefined ? { brokenAtSeq: result.brokenAtSeq } : {}),
    };
  }

  return {
    async list(orgId: string, opts: AuditListOptions): Promise<AuditRecordView[]> {
      const limit = Math.min(Math.max(opts.limit, 1), MAX_LIMIT);
      const rows = await deps.db.withTenant(orgId, { isPlatformAdmin: false }, (tx) =>
        deps.repo.listWithTx(tx, orgId, {
          limit,
          ...(opts.before !== undefined ? { before: opts.before } : {}),
        }),
      );
      return rows.map(toView);
    },

    verify(orgId: string): Promise<AuditVerifyResult> {
      return verifyOrg(orgId);
    },

    async verifyAll(): Promise<AuditVerifyResult[]> {
      const orgs = await deps.db.withTenant(PLATFORM_ADMIN_ORG, { isPlatformAdmin: true }, (tx) =>
        deps.repo.listOrgsWithTx(tx),
      );
      const results: AuditVerifyResult[] = [];
      for (const orgId of orgs) results.push(await verifyOrg(orgId));
      return results;
    },
  };
}
