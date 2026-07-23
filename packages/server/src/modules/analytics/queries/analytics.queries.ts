/**
 * Analytics SQL — the ONLY file in this module with query text. It reads the `usage_rollups_hourly`
 * read model (never the raw `usage_events` partitions). Every user-supplied value (`from`/`to`) is
 * bound as a `$`-param; the GROUP BY column is chosen from a fixed server-side map keyed by a typed
 * enum, so it can never be user text — injection is structurally impossible (DEVELOPMENT.md §3.4).
 */
import type { SqlQuery } from '../../../platform/db.js';
import type { SumUsageOptions, UsageGroupBy } from '../types/analytics.types.js';

/**
 * The enum→column map. This is the ONLY place a `group_by` value becomes SQL, and the key type is the
 * `UsageGroupBy` union — a value outside it cannot index this record, so no unvalidated string ever
 * reaches the query. `day` is formatted to a stable `YYYY-MM-DD` so the bucket key is a plain date.
 */
const GROUP_EXPR: Record<UsageGroupBy, string> = {
  app: 'app_id::text',
  route: 'route_id::text',
  model: 'model',
  day: `to_char(date_trunc('day', hour), 'YYYY-MM-DD')`,
};

/**
 * Sum the rollups grouped by the requested dimension. Sums are cast to text so bigint/numeric values
 * survive the pg driver without precision loss (the service coerces them). Ordered by spend so the
 * biggest cost centres come first. Org scoping is enforced by RLS on the enclosing transaction — the
 * platform-admin variant (`byOrg`) groups by `org_id` to summarize every tenant at once.
 */
export function sumUsageQuery(groupBy: UsageGroupBy, opts: SumUsageOptions): SqlQuery {
  const keyExpr = opts.byOrg ? 'org_id::text' : GROUP_EXPR[groupBy];

  const values: unknown[] = [];
  const where: string[] = [];
  if (opts.from) {
    values.push(opts.from);
    where.push(`hour >= $${values.length}::timestamptz`);
  }
  if (opts.to) {
    values.push(opts.to);
    where.push(`hour < $${values.length}::timestamptz`);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return {
    text: `SELECT ${keyExpr} AS group_key,
                  sum(requests)::text      AS requests,
                  sum(input_tokens)::text  AS input_tokens,
                  sum(output_tokens)::text AS output_tokens,
                  sum(cost_usd)::text      AS cost_usd
             FROM usage_rollups_hourly
             ${whereClause}
             GROUP BY 1
             ORDER BY sum(cost_usd) DESC NULLS LAST, group_key ASC`,
    values,
  };
}
