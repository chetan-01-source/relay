-- 0004_routing.sql — routes, versions, targets (PRD §3 · §4.5, Day 9 module)
-- A route is the named policy object the client's `model` field selects. Rollback =
-- activate an older version. Each version has an ordered/weighted list of targets.

-- ── routes ───────────────────────────────────────────────────────────────────
CREATE TABLE routes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_name        text NOT NULL,                    -- client-facing alias, e.g. "gpt-4o" or "fast"
  active_version_id uuid,                             -- FK added after route_versions exists
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, model_name)
);
CREATE INDEX routes_org_idx ON routes (org_id);

ALTER TABLE routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE routes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routes
  USING (org_id = current_setting('app.current_org')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY platform_admin_access ON routes
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- ── route_versions ───────────────────────────────────────────────────────────
CREATE TABLE route_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  route_id    uuid NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  strategy    text NOT NULL DEFAULT 'priority'
                CHECK (strategy IN ('priority', 'weighted')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_id, version)
);
CREATE INDEX route_versions_org_idx ON route_versions (org_id);
CREATE INDEX route_versions_route_idx ON route_versions (route_id);

ALTER TABLE route_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON route_versions
  USING (org_id = current_setting('app.current_org')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY platform_admin_access ON route_versions
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- now that route_versions exists, wire the active-version pointer
ALTER TABLE routes
  ADD CONSTRAINT routes_active_version_fk
  FOREIGN KEY (active_version_id) REFERENCES route_versions(id) ON DELETE SET NULL;

-- ── route_targets ────────────────────────────────────────────────────────────
-- One upstream target within a version: which credential, which provider-native model,
-- and its priority (lower first) / weight (for weighted strategy).
CREATE TABLE route_targets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  route_version_id  uuid NOT NULL REFERENCES route_versions(id) ON DELETE CASCADE,
  credential_id     uuid NOT NULL REFERENCES provider_credentials(id) ON DELETE RESTRICT,
  provider          text NOT NULL,
  model             text NOT NULL,                    -- provider-native model id sent upstream
  priority          integer NOT NULL DEFAULT 100,     -- lower = tried first (priority strategy)
  weight            integer NOT NULL DEFAULT 1,       -- relative share (weighted strategy)
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX route_targets_org_idx ON route_targets (org_id);
CREATE INDEX route_targets_version_idx ON route_targets (route_version_id);

ALTER TABLE route_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON route_targets
  USING (org_id = current_setting('app.current_org')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY platform_admin_access ON route_targets
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
