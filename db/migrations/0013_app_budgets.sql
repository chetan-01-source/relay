-- 0013_app_budgets.sql — per-application spend ceilings.
--
-- Additive column on the EXISTING tenant table `budgets` (already FORCE RLS + both policies from
-- 0006). No new table → no new RLS block needed; check-rls.sh only gates newly-created tenant tables.
--
-- `app_id IS NULL` means the ceiling is org-wide, which is exactly what every existing row is — so
-- the column is nullable with no default and the backfill is a no-op. A request is checked against
-- BOTH its application's ceiling and the org's; whichever trips first rejects it.
--
-- The unique key has to change with it. `UNIQUE (org_id, app_id, period)` alone would NOT work:
-- Postgres treats NULLs as distinct, so an org could accumulate unlimited org-wide rows for the same
-- period. COALESCE to the nil UUID collapses those to one value, which restores "at most one ceiling
-- per (scope, period)" for the org-wide case too.

ALTER TABLE budgets
  ADD COLUMN IF NOT EXISTS app_id uuid REFERENCES applications(id) ON DELETE CASCADE;

COMMENT ON COLUMN budgets.app_id IS
  'Application this ceiling applies to; NULL = org-wide (Day 16). Cascades with the application.';

-- Replace the org-wide-only constraint with one that admits per-app rows.
ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_org_id_period_key;

CREATE UNIQUE INDEX IF NOT EXISTS budgets_org_scope_period_key
  ON budgets (org_id, COALESCE(app_id, '00000000-0000-0000-0000-000000000000'::uuid), period);

-- Enforcement and the console both read "this app's ceiling, plus the org's" on every resolve.
CREATE INDEX IF NOT EXISTS budgets_org_app_idx ON budgets (org_id, app_id);
