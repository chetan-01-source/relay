-- 0001_organizations.sql — tenancy root (PRD §3 · playbook §3, Day 7 module)
-- organizations is the tenant ROOT: its own id is the boundary, so it has no org_id column.
-- Every other tenant table FKs to organizations(id) and carries org_id + forced RLS.

-- Postgres 16 ships gen_random_uuid() in core; pgcrypto also enabled for digest() (audit chain).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── organizations ───────────────────────────────────────────────────────────
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  logto_org_id  text NOT NULL UNIQUE,                 -- link to the Logto org (identity source of truth)
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- organizations is the tenant root — NOT gated by check-rls.sh (no org_id column) but still
-- RLS-protected: a tenant may read only its own row; platform admins see all.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON organizations
  USING (id = current_setting('app.current_org', true)::uuid);
CREATE POLICY platform_admin_all ON organizations
  USING (current_setting('app.is_platform_admin', true) = 'true');

COMMENT ON TABLE organizations IS 'Tenant root. id is the tenancy boundary; linked to a Logto org via logto_org_id.';
-- org_features (tenant, has org_id) lives in its own migration (0002) so the RLS gate's
-- line-window heuristic never conflates this root table with a following tenant table.
