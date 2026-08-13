-- 0016_chat_notification_channels.sql — Slack and Microsoft Teams as notification channels.
--
-- `notification_channels` was already keyed (org_id, type) with a CHECK that admitted exactly one
-- value. That key is the right shape for several channel kinds — one Slack config per org, one Teams
-- config, one SMTP config — so this widens the CHECK rather than adding a table.
--
-- Three changes, each forced by something webhooks do that SMTP does not:
--
--  1. `type` admits the two webhook kinds. Old rows are 'email_smtp' and unaffected.
--
--  2. `from_address` becomes nullable. It is an SMTP envelope field; a webhook posts INTO a channel
--     that already knows who it is, so there is nothing to put here. NOT NULL would have forced a
--     placeholder, and a placeholder in a column the mailer reads is a latent bug.
--
--  3. `notification_outbox.delivered_to` records which channels a notification actually reached.
--     This is the load-bearing part of the change. One outbox row now fans out to every configured
--     channel, and those fail independently: if Slack is down while SMTP succeeds, retrying the row
--     must NOT re-send the email. Tracking what already landed makes a retry resume rather than
--     repeat, which is the difference between "Slack recovered" and "everyone got the same alert
--     five times".
--
-- The webhook URL itself lives in the SEALED columns (ciphertext/iv/auth_tag/wrapped_dek), not in
-- `config`. It is a bearer credential — possession of the URL is authority to post — so it gets the
-- same envelope encryption as an SMTP password and a provider key, and is never returned by a read.

ALTER TABLE notification_channels DROP CONSTRAINT IF EXISTS notification_channels_type_check;

ALTER TABLE notification_channels
  ADD CONSTRAINT notification_channels_type_check
  CHECK (type IN ('email_smtp', 'slack_webhook', 'msteams_webhook'));

ALTER TABLE notification_channels ALTER COLUMN from_address DROP NOT NULL;

COMMENT ON COLUMN notification_channels.from_address IS
  'SMTP envelope From. NULL for webhook channels, which have no sender address.';

COMMENT ON COLUMN notification_channels.ciphertext IS
  'Sealed channel secret: the SMTP password, or the Slack/Teams webhook URL. Never returned by a read.';

-- Which channel types this notification has already reached. Empty = nothing delivered yet.
ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS delivered_to text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN notification_outbox.delivered_to IS
  'Channel types this row was successfully delivered to. A retry skips these, so a partial failure never re-sends to a channel that already received it.';
