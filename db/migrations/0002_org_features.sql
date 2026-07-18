-- 0002_org_features.sql — per-org entitlements (PRD §3, Day 7 module)
-- Feature flags / entitlement templates, hot-loaded into the policy snapshot and
-- invalidated via Valkey pub/sub (org.features.updated).

CREATE TABLE org_features (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feature_key text NOT NULL,                          -- e.g. 'cache.exact', 'modalities.image'
  value       jsonb NOT NULL DEFAULT 'true'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, feature_key)
);
CREATE INDEX org_features_org_idx ON org_features (org_id);

ALTER TABLE org_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_features FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_features
  USING (org_id = current_setting('app.current_org')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY platform_admin_access ON org_features
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
