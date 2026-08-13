-- 0015_app_routes_org_members.sql — per-application routes, and org-level membership roles.
--
-- Two independent changes, one migration, because both land the same feature set:
--
--  1. `routes.app_id` — a route may now belong to ONE application, or to the org as before. This
--     mirrors `budgets.app_id` (0013) exactly, including the COALESCE-to-nil unique trick, so the
--     two scoping models read the same way. The difference is how they compose: budgets INTERSECT
--     (both ceilings apply), routes OVERRIDE (the app's route wins, the org's is the fallback).
--     Resolution is "app route if one exists for this model, else the org route, else 404".
--
--  2. `org_members` — who belongs to a tenant, and as what. Membership itself lives in Logto; this
--     table records the ROLE Relay enforces, which Logto has no opinion about. It is written when an
--     invitation is accepted and by a platform admin promoting someone.
--
--     Why a Relay table rather than reading Logto's organization roles per request: authorization on
--     the control plane must not depend on a network call to Logto, on that role surviving a Logto
--     upgrade, or on the token carrying a claim we do not control. The role is ours to enforce, so
--     the row is ours to own.

-- ── 1. Per-application routes ───────────────────────────────────────────────────────────────────
ALTER TABLE routes
  ADD COLUMN IF NOT EXISTS app_id uuid REFERENCES applications(id) ON DELETE CASCADE;

COMMENT ON COLUMN routes.app_id IS
  'Application this route is scoped to; NULL = org-wide default. An app route overrides the org one for the same model_name.';

-- The old key admitted exactly one route per model name per org. Drop it, then restore the same
-- guarantee per SCOPE: NULLs compare as distinct in Postgres, so without the COALESCE an org could
-- accumulate unlimited org-wide routes for one model — the ambiguity this constraint exists to stop.
ALTER TABLE routes DROP CONSTRAINT IF EXISTS routes_org_id_model_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS routes_org_scope_model_key
  ON routes (org_id, COALESCE(app_id, '00000000-0000-0000-0000-000000000000'::uuid), model_name);

-- The hot path resolves by (org, model) and prefers the row whose app_id matches the caller's app.
CREATE INDEX IF NOT EXISTS routes_org_app_idx ON routes (org_id, app_id);

-- ── 2. Organization membership roles ────────────────────────────────────────────────────────────
-- `user_id` is Logto's user id (a 21-char string), NOT a uuid — it is a foreign identity and this
-- table is the join between it and our tenant. `email` is a denormalised convenience copy for the
-- members screen; Logto stays the source of truth for the account itself.
CREATE TABLE org_members (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    text NOT NULL,
  role       text NOT NULL DEFAULT 'member',
  email      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id),
  CONSTRAINT org_members_role_check CHECK (role IN ('admin', 'member'))
);

COMMENT ON TABLE org_members IS
  'Role a user holds within one organization. admin = may change budgets and provider credentials; member = read-only on those. Absent row ⇒ member.';

CREATE INDEX org_members_org_idx ON org_members (org_id);

ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_members
  USING (org_id = (current_setting('app.current_org'))::uuid)
  WITH CHECK (org_id = (current_setting('app.current_org'))::uuid);
CREATE POLICY platform_admin_access ON org_members
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
