-- 0005_policy.sql — budgets + rate limits (PRD §3 · §4.6, Day 10 module)
-- These tables hold CONFIG. The live counters live in Valkey (atomic Lua reserve/settle);
-- Postgres is config + the reconciliation target, never the hot-path counter.

-- ── budgets ──────────────────────────────────────────────────────────────────
CREATE TABLE budgets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period       text NOT NULL DEFAULT 'monthly'
                 CHECK (period IN ('daily', 'monthly')),
  limit_usd    numeric(12,4) NOT NULL,
  hard_cutoff  boolean NOT NULL DEFAULT true,         -- true = block at limit; false = alert only
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, period)
);
CREATE INDEX budgets_org_idx ON budgets (org_id);

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON budgets
  USING (org_id = current_setting('app.current_org')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY platform_admin_access ON budgets
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- ── rate_limits ──────────────────────────────────────────────────────────────
CREATE TABLE rate_limits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope       text NOT NULL DEFAULT 'org'
                CHECK (scope IN ('org', 'key')),
  rpm         integer,                                -- requests per minute (null = unlimited)
  tpm         integer,                                -- tokens per minute   (null = unlimited)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, scope)
);
CREATE INDEX rate_limits_org_idx ON rate_limits (org_id);

ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rate_limits
  USING (org_id = current_setting('app.current_org')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY platform_admin_access ON rate_limits
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
