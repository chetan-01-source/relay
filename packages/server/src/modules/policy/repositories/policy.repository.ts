/**
 * Policy repository — data access only. Reads the durable spend record so a cold budget counter can
 * be seeded with what the period has ALREADY cost. Contains no query text and no business rules.
 */
import type { Database } from '../../../platform/db.js';
import { periodSpendMicroUsdQuery } from '../queries/policy.queries.js';
import type { SpendReader } from '../types/policy.types.js';

export function createPolicyRepository(db: Database): SpendReader {
  return {
    async periodSpendMicroUsd(orgId, appId, periodStart) {
      const rows = await db.withTenant(orgId, { isPlatformAdmin: false }, (tx) =>
        tx.run<{ micro_usd: string }>(periodSpendMicroUsdQuery(orgId, appId, periodStart)),
      );
      // pg returns bigint as text; a missing row (impossible with an aggregate, but cheap to guard)
      // reads as zero, which is the safe direction — it can only under-seed, never over-block.
      return Number(rows[0]?.micro_usd ?? 0);
    },
  };
}
