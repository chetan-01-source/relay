/**
 * Metering repository (DEVELOPMENT.md §2) — data access only. Runs the parametrized queries against
 * the caller's transaction (a Queryable from withTenant). Contains NO query text and NO business logic.
 */
import {
  insertUsageEventsQuery,
  listOrgsWithUsageSinceQuery,
  deleteRollupsForOrgSinceQuery,
  rebuildRollupsForOrgSinceQuery,
} from '../queries/metering.queries.js';
import type { MeteringRepository } from '../types/metering.types.js';

export function createMeteringRepository(): MeteringRepository {
  return {
    async insertEvents(tx, events) {
      if (events.length === 0) return;
      await tx.run(insertUsageEventsQuery(events));
    },
    async listOrgsWithUsageSince(tx, sinceHourIso) {
      const rows = await tx.run<{ org_id: string }>(listOrgsWithUsageSinceQuery(sinceHourIso));
      return rows.map((r) => r.org_id);
    },
    async rebuildRollupsForOrgSince(tx, orgId, sinceHourIso) {
      // Delete-then-insert within one transaction ⇒ the recompute is atomic and idempotent.
      await tx.run(deleteRollupsForOrgSinceQuery(orgId, sinceHourIso));
      await tx.run(rebuildRollupsForOrgSinceQuery(orgId, sinceHourIso));
    },
  };
}
