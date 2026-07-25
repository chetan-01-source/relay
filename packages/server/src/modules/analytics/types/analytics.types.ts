/**
 * Analytics module interfaces (Week 3 Day 12). A control-plane read surface over the hourly usage
 * rollups (`usage_rollups_hourly`) — the dashboard read model. It NEVER reads the raw `usage_events`
 * partitions (non-negotiable #3: dashboards read rollups only). Every layer depends on an interface
 * declared here; the service is unit-testable with a fake repository.
 *
 * Layering (DEVELOPMENT.md §2): routes → controller → service → repository → queries.
 */
import type { Queryable } from '../../../platform/db.js';

/** How org spend is grouped. Validated against this allowlist at the controller boundary — the value
 * is a typed enum, never interpolated into SQL (the enum→column map lives in analytics.queries.ts). */
export type UsageGroupBy = 'app' | 'route' | 'model' | 'day';

/** The allowlist the controller validates the `group_by` query param against. */
export const USAGE_GROUP_BY: readonly UsageGroupBy[] = ['app', 'route', 'model', 'day'];

/** Filters for a usage query. `from`/`to` bound the hour window (ISO-8601, `$`-bound in the query). */
export interface UsageQueryOptions {
  groupBy: UsageGroupBy;
  from?: string; // inclusive lower bound on `hour`
  to?: string; // exclusive upper bound on `hour`
}

/** One aggregated row as it comes back from Postgres. bigint sums (`requests`, token totals) and the
 * numeric `cost_usd` all arrive as strings from pg — the service coerces them to numbers. */
export interface UsageAggregateRow {
  group_key: string | null;
  requests: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cost_usd: string | null;
}

/** One grouped bucket of spend in the API response. */
export interface UsageBucket {
  key: string; // the group value: an app/route id, a model id, an ISO date, or an org id (admin)
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

/** The usage summary envelope returned to clients. `group_by` echoes the requested grouping
 * (`org` for the platform-admin cross-org variant). */
export interface UsageSummary {
  object: 'analytics.usage';
  group_by: UsageGroupBy | 'org';
  data: UsageBucket[];
}

/** Options passed down to the query builder. `byOrg` switches the group key to `org_id` for the
 * platform-admin cross-org summary; otherwise the requested `groupBy` column is used. */
export interface SumUsageOptions {
  orgId?: string; // explicit org filter for the tenant-scoped read (defense-in-depth with RLS)
  from?: string;
  to?: string;
  byOrg?: boolean;
}

/** Data-access boundary. The ONLY layer that touches the database. Runs inside a caller-supplied
 * tenant transaction (`withTenant`) so RLS scopes rollups to exactly one org (or, for the admin
 * variant, a platform-admin transaction that reads across orgs). */
export interface AnalyticsRepository {
  sumUsage(
    tx: Queryable,
    groupBy: UsageGroupBy,
    opts: SumUsageOptions,
  ): Promise<UsageAggregateRow[]>;
}

/** Business boundary. Opens the tenant transaction and maps rows → API buckets. No SQL, no HTTP. */
export interface AnalyticsService {
  /** Grouped spend for one org (tenant-scoped, RLS-isolated). */
  getUsage(orgId: string, opts: UsageQueryOptions): Promise<UsageSummary>;
  /** Cross-org spend summary grouped by org — platform-admin only. */
  getUsageAllOrgs(opts: { from?: string; to?: string }): Promise<UsageSummary>;
}
