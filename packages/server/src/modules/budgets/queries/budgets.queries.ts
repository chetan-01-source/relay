/**
 * Budgets SQL — the ONLY file in this module with query text. Every value is bound as a $-param and
 * never interpolated, so these statements are injection-safe by construction (DEVELOPMENT.md §3.4).
 * All of them run inside the caller's tenant transaction, so RLS scopes them to one org.
 *
 * A ceiling is identified by `(org_id, app_id, period)` where `app_id IS NULL` means org-wide. NULL
 * does not compare with `=`, so the scope predicate uses `IS NOT DISTINCT FROM` — with plain `=` an
 * org-wide row could never be matched, silently turning every write into an insert.
 */
import type { SqlQuery } from '../../../platform/db.js';

// limit_usd is numeric(12,4); pg returns numeric as text to avoid float drift. Cast explicitly so the
// intent is visible at the call site rather than depending on the driver's default.
const COLUMNS =
  'id, org_id, app_id, period, limit_usd::text AS limit_usd, hard_cutoff, created_at, updated_at';

/** Every ceiling for the org — org-wide and per-application — org-wide first, then by app. */
export function listBudgetsQuery(orgId: string): SqlQuery {
  return {
    text: `SELECT ${COLUMNS} FROM budgets WHERE org_id = $1 ORDER BY app_id NULLS FIRST, period`,
    values: [orgId],
  };
}

/** One ceiling by its natural key. `appId` NULL selects the org-wide row. */
export function getBudgetQuery(orgId: string, appId: string | null, period: string): SqlQuery {
  return {
    text: `SELECT ${COLUMNS}
             FROM budgets
            WHERE org_id = $1 AND app_id IS NOT DISTINCT FROM $2 AND period = $3`,
    values: [orgId, appId, period],
  };
}

/**
 * Insert or update a ceiling.
 *
 * The unique index is on `(org_id, COALESCE(app_id, nil-uuid), period)`, so ON CONFLICT has to name
 * that same expression — naming the bare columns would not match the index and the upsert would
 * raise instead of updating.
 */
export function upsertBudgetQuery(
  orgId: string,
  appId: string | null,
  period: string,
  limitUsd: number,
  hardCutoff: boolean,
): SqlQuery {
  return {
    text: `INSERT INTO budgets (org_id, app_id, period, limit_usd, hard_cutoff)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (org_id, COALESCE(app_id, '00000000-0000-0000-0000-000000000000'::uuid), period)
           DO UPDATE SET limit_usd = EXCLUDED.limit_usd,
                         hard_cutoff = EXCLUDED.hard_cutoff,
                         updated_at = now()
           RETURNING ${COLUMNS}`,
    values: [orgId, appId, period, limitUsd, hardCutoff],
  };
}

/** Delete a ceiling, returning the id when a row was actually removed. */
export function deleteBudgetQuery(orgId: string, appId: string | null, period: string): SqlQuery {
  return {
    text: `DELETE FROM budgets
            WHERE org_id = $1 AND app_id IS NOT DISTINCT FROM $2 AND period = $3
        RETURNING id`,
    values: [orgId, appId, period],
  };
}
