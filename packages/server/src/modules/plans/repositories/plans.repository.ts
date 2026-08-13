/**
 * Plans repository (DEVELOPMENT.md §2) — data access only. Executes the parametrized queries against
 * the caller's transaction; contains NO query text and NO business rules.
 */
import {
  getPlanQuery,
  getSubscriptionQuery,
  listOrgFeaturesQuery,
  listPublicPlansQuery,
  upsertSubscriptionQuery,
  usageCountsQuery,
} from '../queries/plans.queries.js';
import type {
  PlanRow,
  PlansRepository,
  QuotaUsage,
  SubscriptionRow,
} from '../types/plans.types.js';

/** pg returns count() as bigint, which the driver hands back as a string. */
interface UsageRow {
  apps: string;
  providers: string;
  routes: string;
  members: string;
  keys_in_app: string;
}

export function createPlansRepository(): PlansRepository {
  return {
    async getPlan(tx, code) {
      const rows = await tx.run<PlanRow>(getPlanQuery(code));
      return rows[0] ?? null;
    },

    listPublicPlans(tx) {
      return tx.run<PlanRow>(listPublicPlansQuery());
    },

    async getSubscription(tx, orgId) {
      const rows = await tx.run<SubscriptionRow>(getSubscriptionQuery(orgId));
      return rows[0] ?? null;
    },

    async upsertSubscription(tx, orgId, input) {
      const rows = await tx.run<SubscriptionRow>(
        upsertSubscriptionQuery(orgId, {
          planCode: input.planCode,
          status: input.status ?? null,
          trialEndsAt: input.trialEndsAt ?? null,
          graceUntil: input.graceUntil ?? null,
          currentPeriodEnd: input.currentPeriodEnd ?? null,
          overrides: input.overrides ? JSON.stringify(input.overrides) : null,
          provider: input.provider ?? null,
          providerRef: input.providerRef ?? null,
        }),
      );
      // RETURNING on an upsert always yields exactly one row; a miss is a broken invariant.
      return rows[0]!;
    },

    listFeatures(tx, orgId) {
      return tx.run<{ feature_key: string; value: unknown }>(listOrgFeaturesQuery(orgId));
    },

    async usage(tx, orgId, scope) {
      const rows = await tx.run<UsageRow>(usageCountsQuery(orgId, scope?.appId ?? null));
      const row = rows[0];
      const counts: QuotaUsage = {
        'apps.max': Number(row?.apps ?? 0),
        'providers.max': Number(row?.providers ?? 0),
        'routes.max': Number(row?.routes ?? 0),
        'members.max': Number(row?.members ?? 0),
        'keys.per_app.max': Number(row?.keys_in_app ?? 0),
      };
      return counts;
    },
  };
}
