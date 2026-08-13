/**
 * Policy SQL — the ONLY file in this module with query text. Values are bound as $-params, never
 * interpolated, so these statements are injection-safe by construction (DEVELOPMENT.md §3.4).
 */
import type { SqlQuery } from '../../../platform/db.js';

/**
 * Spend already made in the current period, in micro-USD, for one budget scope.
 *
 * Reads `usage_events` (the durable per-request record) rather than the hourly rollups: the rollups
 * are recomputed on a timer, so the current hour is routinely incomplete, and seeding a ceiling from
 * a number that lags by up to a minute would hand back exactly the allowance this is meant to close.
 * The `(org_id, app_id, created_at)` index covers the app-scoped case and `(org_id, created_at)` the
 * org-wide one, and the range is bounded to a single period.
 *
 * `appId` null sums the whole org; a value narrows to that application.
 */
export function periodSpendMicroUsdQuery(
  orgId: string,
  appId: string | null,
  periodStart: string,
): SqlQuery {
  return {
    text: `SELECT COALESCE(ROUND(SUM(cost_usd) * 1000000), 0)::bigint AS micro_usd
             FROM usage_events
            WHERE org_id = $1
              AND ($2::uuid IS NULL OR app_id = $2::uuid)
              AND created_at >= $3::timestamptz`,
    values: [orgId, appId, periodStart],
  };
}
