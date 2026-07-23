/**
 * Analytics repository (DEVELOPMENT.md §2) — data access only. Runs the parametrized query from
 * analytics.queries.ts against the caller's tenant transaction (a Queryable scoped by `withTenant`,
 * so RLS isolates the rollups to one org). Holds no query text and no business logic.
 */
import type { Queryable } from '../../../platform/db.js';
import { sumUsageQuery } from '../queries/analytics.queries.js';
import type {
  AnalyticsRepository,
  SumUsageOptions,
  UsageAggregateRow,
  UsageGroupBy,
} from '../types/analytics.types.js';

export function createAnalyticsRepository(): AnalyticsRepository {
  return {
    sumUsage(
      tx: Queryable,
      groupBy: UsageGroupBy,
      opts: SumUsageOptions,
    ): Promise<UsageAggregateRow[]> {
      return tx.run<UsageAggregateRow>(sumUsageQuery(groupBy, opts));
    },
  };
}
