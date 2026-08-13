-- 0014_notifications.sql — tenant-aware notification delivery (channels, preferences, outbox).
--
-- Three NEW tenant tables, so each carries FORCE RLS + both policies (check-rls.sh gates this).
--
-- Design notes that the schema encodes:
--
--  * `notification_channels` holds a tenant's OWN transport credentials, sealed with the same
--    envelope crypto as provider_credentials (ciphertext/iv/auth_tag/wrapped_dek). No plaintext
--    secret is ever stored or returned. A tenant with no enabled channel falls back to the
--    platform default from env — configuring one is an override, not a prerequisite.
--
--  * `notification_outbox` is BOTH the work queue and the delivery log. Rows are enqueued inside the
--    same transaction as the change that caused them, so a committed change always has a pending
--    notification and a rolled-back one has none — no dual-write race.
--
--  * `dedupe_key` is the load-bearing column. A tripped budget rejects EVERY request, so without it
--    one exceeded ceiling would mail the org thousands of times. The partial unique index collapses
--    repeats of the same logical event (one per ceiling per period) while leaving rows with no
--    dedupe key unconstrained.

-- ── Channels ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE notification_channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type          text NOT NULL DEFAULT 'email_smtp',
  from_address  text NOT NULL,
  -- Sealed SMTP credential (the password/API key). Same envelope scheme as provider_credentials.
  ciphertext    bytea,
  iv            bytea,
  auth_tag      bytea,
  wrapped_dek   bytea,
  -- Non-secret connection settings; the secret half lives in the sealed columns above.
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_channels_type_check CHECK (type IN ('email_smtp')),
  -- One channel per type per org: a second SMTP config would make "which one sends?" ambiguous.
  CONSTRAINT notification_channels_org_type_key UNIQUE (org_id, type)
);

ALTER TABLE notification_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_channels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_channels
  USING (org_id = (current_setting('app.current_org'))::uuid)
  WITH CHECK (org_id = (current_setting('app.current_org'))::uuid);
CREATE POLICY platform_admin_access ON notification_channels
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- ── Preferences ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE notification_preferences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  -- Extra addresses beyond the org's members (on-call alias, finance, etc). Members are resolved
  -- from Logto at send time rather than copied here, so removing a member stops their mail.
  recipients  text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_preferences_org_event_key UNIQUE (org_id, event_type)
);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_preferences
  USING (org_id = (current_setting('app.current_org'))::uuid)
  WITH CHECK (org_id = (current_setting('app.current_org'))::uuid);
CREATE POLICY platform_admin_access ON notification_preferences
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- ── Outbox (queue + delivery log) ───────────────────────────────────────────────────────────────
CREATE TABLE notification_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Collapses repeats of one logical event; NULL means "always a distinct notification".
  dedupe_key      text,
  status          text NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  recipients      text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  CONSTRAINT notification_outbox_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'suppressed'))
);

ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_outbox
  USING (org_id = (current_setting('app.current_org'))::uuid)
  WITH CHECK (org_id = (current_setting('app.current_org'))::uuid);
CREATE POLICY platform_admin_access ON notification_outbox
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- One row per logical event. Partial so un-deduped notifications are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_dedupe_key
  ON notification_outbox (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- The dispatcher's claim query: due pending rows, oldest first.
CREATE INDEX IF NOT EXISTS notification_outbox_due_idx
  ON notification_outbox (status, next_attempt_at) WHERE status = 'pending';

-- The console's delivery log: newest first per tenant.
CREATE INDEX IF NOT EXISTS notification_outbox_org_time_idx
  ON notification_outbox (org_id, created_at DESC);

COMMENT ON TABLE notification_outbox IS
  'Durable notification queue AND delivery log. Enqueued in the same transaction as the change that caused it.';
