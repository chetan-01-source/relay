/**
 * Notifications SQL — the ONLY file in this module with query text. Every value is bound as a
 * $-param and never interpolated, so these statements are injection-safe by construction
 * (DEVELOPMENT.md §3.4).
 */
import type { SqlQuery } from '../../../platform/db.js';

const CHANNEL_COLUMNS =
  'id, org_id, type, from_address, ciphertext, iv, auth_tag, wrapped_dek, config, enabled, created_at, updated_at';

/** One channel by kind. The org may configure email, Slack and Teams independently. */
export function getChannelQuery(orgId: string, type: string): SqlQuery {
  return {
    text: `SELECT ${CHANNEL_COLUMNS} FROM notification_channels WHERE org_id = $1 AND type = $2`,
    values: [orgId, type],
  };
}

/** Every channel the org has configured — what the console lists and the dispatcher fans out over. */
export function listChannelsQuery(orgId: string): SqlQuery {
  return {
    text: `SELECT ${CHANNEL_COLUMNS} FROM notification_channels WHERE org_id = $1 ORDER BY type`,
    values: [orgId],
  };
}

/**
 * Upsert the org's channel. `$5::bytea IS NULL` keeps the stored secret when the caller did not
 * supply a new one — re-saving the host or port must not silently wipe the password.
 */
export function upsertChannelQuery(input: {
  orgId: string;
  type: string;
  fromAddress: string | null;
  config: unknown;
  enabled: boolean;
  ciphertext: Buffer | null;
  iv: Buffer | null;
  authTag: Buffer | null;
  wrappedDek: Buffer | null;
}): SqlQuery {
  return {
    text: `INSERT INTO notification_channels
             (org_id, type, from_address, config, enabled, ciphertext, iv, auth_tag, wrapped_dek)
           VALUES ($1, $9, $2, $3::jsonb, $4, $5, $6, $7, $8)
           ON CONFLICT (org_id, type) DO UPDATE SET
             from_address = EXCLUDED.from_address,
             config       = EXCLUDED.config,
             enabled      = EXCLUDED.enabled,
             ciphertext   = COALESCE(EXCLUDED.ciphertext,  notification_channels.ciphertext),
             iv           = COALESCE(EXCLUDED.iv,          notification_channels.iv),
             auth_tag     = COALESCE(EXCLUDED.auth_tag,    notification_channels.auth_tag),
             wrapped_dek  = COALESCE(EXCLUDED.wrapped_dek, notification_channels.wrapped_dek),
             updated_at   = now()
           RETURNING ${CHANNEL_COLUMNS}`,
    values: [
      input.orgId,
      input.fromAddress,
      JSON.stringify(input.config),
      input.enabled,
      input.ciphertext,
      input.iv,
      input.authTag,
      input.wrappedDek,
      input.type,
    ],
  };
}

export function deleteChannelQuery(orgId: string, type: string): SqlQuery {
  return {
    text: `DELETE FROM notification_channels WHERE org_id = $1 AND type = $2 RETURNING id`,
    values: [orgId, type],
  };
}

const PREFERENCE_COLUMNS = 'id, org_id, event_type, enabled, recipients, created_at, updated_at';

export function listPreferencesQuery(orgId: string): SqlQuery {
  return {
    text: `SELECT ${PREFERENCE_COLUMNS} FROM notification_preferences WHERE org_id = $1 ORDER BY event_type`,
    values: [orgId],
  };
}

export function upsertPreferenceQuery(
  orgId: string,
  eventType: string,
  enabled: boolean,
  recipients: string[],
): SqlQuery {
  return {
    text: `INSERT INTO notification_preferences (org_id, event_type, enabled, recipients)
           VALUES ($1, $2, $3, $4::text[])
           ON CONFLICT (org_id, event_type)
           DO UPDATE SET enabled = EXCLUDED.enabled,
                         recipients = EXCLUDED.recipients,
                         updated_at = now()
           RETURNING ${PREFERENCE_COLUMNS}`,
    values: [orgId, eventType, enabled, recipients],
  };
}

const OUTBOX_COLUMNS =
  'id, org_id, event_type, payload, dedupe_key, status, attempts, next_attempt_at, last_error, recipients, delivered_to, created_at, sent_at';

/**
 * Enqueue a notification. `ON CONFLICT DO NOTHING` against the partial unique index is what makes a
 * high-volume event safe: the second and every later occurrence of the same logical event is a
 * no-op, so a tripped budget mails once per period rather than once per rejected request.
 */
export function enqueueQuery(
  orgId: string,
  eventType: string,
  payload: unknown,
  dedupeKey: string | null,
): SqlQuery {
  return {
    text: `INSERT INTO notification_outbox (org_id, event_type, payload, dedupe_key)
           VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
           RETURNING id`,
    values: [orgId, eventType, JSON.stringify(payload), dedupeKey],
  };
}

export function listOutboxQuery(orgId: string, limit: number): SqlQuery {
  return {
    text: `SELECT ${OUTBOX_COLUMNS} FROM notification_outbox
            WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2`,
    values: [orgId, limit],
  };
}

/**
 * Claim a batch of due notifications for this worker.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets several gateway workers share one outbox: each claims rows
 * the others are not holding, instead of every worker fighting over the same head of the queue.
 * The status flips to 'sending' in the same statement, so a crash mid-send leaves an obvious
 * in-flight row rather than a duplicate delivery.
 */
export function claimDueQuery(limit: number): SqlQuery {
  return {
    text: `UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1
            WHERE id IN (
              SELECT id FROM notification_outbox
               WHERE status = 'pending' AND next_attempt_at <= now()
               ORDER BY created_at
               LIMIT $1
               FOR UPDATE SKIP LOCKED
            )
        RETURNING ${OUTBOX_COLUMNS}`,
    values: [limit],
  };
}

export function markSentQuery(id: string, recipients: string[], deliveredTo: string[]): SqlQuery {
  return {
    text: `UPDATE notification_outbox
              SET status = 'sent', sent_at = now(), last_error = NULL,
                  recipients = $2::text[], delivered_to = $3::text[]
            WHERE id = $1`,
    values: [id, recipients, deliveredTo],
  };
}

/**
 * Record a partial delivery before scheduling the retry.
 *
 * Written separately from the retry itself so the channels that DID succeed are durable even if the
 * row goes on to fail: without it, a retry would re-send to every channel and the tenant would get
 * the same alert once per attempt from whichever channel was healthy.
 */
export function markDeliveredToQuery(
  id: string,
  recipients: string[],
  deliveredTo: string[],
): SqlQuery {
  return {
    text: `UPDATE notification_outbox
              SET recipients = $2::text[], delivered_to = $3::text[]
            WHERE id = $1`,
    values: [id, recipients, deliveredTo],
  };
}

/** Schedule a retry, or give up once the attempt ceiling is reached. */
export function markRetryQuery(
  id: string,
  error: string,
  backoffSeconds: number,
  dead: boolean,
): SqlQuery {
  return {
    text: `UPDATE notification_outbox
              SET status = $4, last_error = $2,
                  next_attempt_at = now() + ($3 || ' seconds')::interval
            WHERE id = $1`,
    values: [id, error.slice(0, 500), String(backoffSeconds), dead ? 'failed' : 'pending'],
  };
}

/** A notification nobody can receive (no channel, or the tenant switched the event off). */
export function markSuppressedQuery(id: string, reason: string): SqlQuery {
  return {
    text: `UPDATE notification_outbox SET status = 'suppressed', last_error = $2 WHERE id = $1`,
    values: [id, reason.slice(0, 500)],
  };
}

/** The org's display name — the only tenant fact a rendered message needs. */
export function loadOrgNameQuery(orgId: string): SqlQuery {
  return {
    text: `SELECT name AS org_name FROM organizations WHERE id = $1`,
    values: [orgId],
  };
}

/** Every ENABLED channel for the org, with its sealed secret — the dispatcher's fan-out list. */
export function loadDeliveryChannelsQuery(orgId: string): SqlQuery {
  return {
    text: `SELECT type, from_address, config, ciphertext, iv, auth_tag, wrapped_dek
             FROM notification_channels
            WHERE org_id = $1 AND enabled = true
            ORDER BY type`,
    values: [orgId],
  };
}

export function getPreferenceQuery(orgId: string, eventType: string): SqlQuery {
  return {
    text: `SELECT enabled, recipients FROM notification_preferences WHERE org_id = $1 AND event_type = $2`,
    values: [orgId, eventType],
  };
}
