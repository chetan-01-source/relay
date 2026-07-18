-- 0002_applications_keys.sql — apps + virtual keys (PRD §3 · playbook §3, Day 8 module)
-- Two-key model, inbound side: virtual keys are hashed (SHA-256) at rest, plaintext shown once.

-- ── applications ─────────────────────────────────────────────────────────────
CREATE TABLE applications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX applications_org_idx ON applications (org_id);

ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON applications
  USING (org_id = current_setting('app.current_org')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY platform_admin_access ON applications
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- ── virtual_keys ─────────────────────────────────────────────────────────────
-- Inbound identity (rk_live_… / rk_test_…). key_sha256 is the lookup key; plaintext
-- is returned to the caller exactly once at issue and never stored. Rotation keeps the
-- old key valid until grace_until, pointing at its successor.
CREATE TABLE virtual_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  app_id       uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  key_sha256   bytea NOT NULL UNIQUE,                 -- SHA-256(plaintext); constant-time compared
  last4        text NOT NULL,                         -- display only: rk_live_…abcd
  name         text,
  environment  text NOT NULL DEFAULT 'live'
                 CHECK (environment IN ('live', 'test')),
  status       text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'revoked')),
  successor_id uuid REFERENCES virtual_keys(id) ON DELETE SET NULL,  -- set on rotate
  grace_until  timestamptz,                           -- old key valid until this instant
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX virtual_keys_org_idx ON virtual_keys (org_id);
CREATE INDEX virtual_keys_app_idx ON virtual_keys (app_id);

ALTER TABLE virtual_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE virtual_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON virtual_keys
  USING (org_id = current_setting('app.current_org')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY platform_admin_access ON virtual_keys
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

COMMENT ON COLUMN virtual_keys.key_sha256 IS 'SHA-256 of the plaintext key. Plaintext is never stored or logged.';
