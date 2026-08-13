/**
 * Notifications service — tenant-facing configuration plus the write side other modules enqueue
 * through. No SQL, no HTTP.
 *
 * The SMTP password is sealed with the same envelope crypto as provider credentials and is NEVER
 * returned by any read — the wire shape exposes `has_secret`, not the value.
 */
import { RelayError } from '@relay-ai/shared';
import { openCredential, sealCredential } from '../../../platform/crypto.js';
import type { Database, Queryable } from '../../../platform/db.js';
import type { AuditRepository } from '../../audit/index.js';
import type { PlansService } from '../../plans/index.js';
import { EVENT_CATALOGUE, definitionFor, type NotificationEvent } from '../lib/events.js';
import { checkWebhookUrl, maskWebhookUrl } from '../lib/webhook-url.js';
import { createSlackSender, createTeamsSender, createSmtpSender } from './sender.js';
import type {
  Channel,
  ChannelRow,
  ChannelTestResult,
  ChannelType,
  SetChannelInput,
  EnqueueInput,
  NotificationEnqueuer,
  NotificationsRepository,
  NotificationsService,
  OutboxEntry,
  OutboxRow,
  Preference,
  PreferenceRow,
} from '../types/notifications.types.js';

export interface NotificationsServiceDeps {
  db: Database;
  repo: NotificationsRepository;
  audit: AuditRepository;
  masterKey: string;
  /** Gates the chat channels behind `notifications.chat`. Absent ⇒ every channel type is allowed. */
  plans?: PlansService;
}

export function createNotificationsService(
  deps: NotificationsServiceDeps,
): NotificationsService & NotificationEnqueuer {
  const { db, repo, audit, masterKey, plans } = deps;
  const scope = { isPlatformAdmin: false };

  /**
   * Reject a save that would leave a channel with no credential at all.
   *
   * Omitting the secret means "keep the stored one" — which is only meaningful if one IS stored.
   * On a first save it would otherwise persist a channel that can never deliver, and the failure
   * would surface hours later in the delivery log rather than on the form.
   */
  async function requireExistingSecret(orgId: string, type: ChannelType): Promise<void> {
    const existing = await db.withTenant(orgId, scope, (tx) => repo.getChannel(tx, orgId, type));
    if (!existing?.ciphertext) {
      throw new RelayError('invalid_request', {
        message:
          type === 'email_smtp'
            ? 'A password is required the first time you save SMTP settings.'
            : 'A webhook URL is required.',
        param: type === 'email_smtp' ? 'password' : 'webhook_url',
      });
    }
  }

  return {
    async getChannel(orgId, type) {
      const row = await db.withTenant(orgId, scope, (tx) => repo.getChannel(tx, orgId, type));
      return row ? toChannel(row) : null;
    },

    async listChannels(orgId) {
      const rows = await db.withTenant(orgId, scope, (tx) => repo.listChannels(tx, orgId));
      return rows.map(toChannel);
    },

    async setChannel(actor, orgId, input) {
      // Email always works — a gateway that cannot tell you your budget tripped is not a product.
      // Slack and Teams are the plan-gated pair, refused with plan_upgrade_required rather than a
      // validation error so the console can offer the upgrade instead of a dead end.
      if (input.type !== 'email_smtp') await plans?.assertFeature(orgId, 'notifications.chat');
      const secret = validateChannel(input);

      // Seal BEFORE the transaction — the plaintext exists only for this call. An absent secret
      // means "keep what is stored"; the query's COALESCE handles that, which is what lets someone
      // disable a channel without re-pasting a webhook URL they no longer have.
      const sealed = secret ? sealCredential(masterKey, secret) : null;
      if (!sealed) await requireExistingSecret(orgId, input.type);

      const row = await db.withTenant(orgId, scope, async (tx) => {
        const saved = await repo.upsertChannel(tx, orgId, input, sealed);
        await audit.appendWithTx(tx, orgId, {
          actor,
          action: 'notification.channel.updated',
          target: saved.id,
          // The secret is never audited — only that one was set. For a webhook that means the URL
          // never reaches the audit trail, which is readable by everyone in the org.
          data: {
            type: input.type,
            ...(input.type === 'email_smtp'
              ? { host: input.host, from_address: input.fromAddress }
              : { target: secret ? maskWebhookUrl(secret) : undefined }),
            enabled: input.enabled,
            secret_changed: !!sealed,
          },
        });
        return saved;
      });
      return toChannel(row);
    },

    async deleteChannel(actor, orgId, type) {
      await db.withTenant(orgId, scope, async (tx) => {
        const existing = await repo.getChannel(tx, orgId, type);
        if (!existing) {
          throw new RelayError('not_found', {
            message: `No ${LABEL[type]} channel is configured.`,
          });
        }
        await audit.appendWithTx(tx, orgId, {
          actor,
          action: 'notification.channel.deleted',
          target: existing.id,
          data: { type },
        });
        await repo.deleteChannel(tx, orgId, type);
      });
    },

    async testChannel(actor, orgId, type) {
      const row = await db.withTenant(orgId, scope, (tx) => repo.getChannel(tx, orgId, type));
      if (!row) {
        throw new RelayError('not_found', { message: `No ${LABEL[type]} channel is configured.` });
      }
      const secret = openChannelSecret(masterKey, row);
      if (!secret) {
        throw new RelayError('invalid_request', {
          message: `This ${LABEL[type]} channel has no credential stored. Save one first.`,
        });
      }

      const message = {
        subject: '[Relay] Test notification',
        text: 'This is a test from the Relay console. If you can read this, the channel works.',
      };

      // A failed test is a RESULT, not an error: the operator asked "does this work?" and "no,
      // because Slack says invalid_token" is the useful answer. Only a missing channel is a 4xx.
      try {
        if (type === 'email_smtp') {
          if (!row.from_address || !row.config?.host || !row.config.port) {
            return fail(type, 'The SMTP settings are incomplete.');
          }
          await createSmtpSender({
            host: row.config.host,
            port: row.config.port,
            secure: row.config.secure ?? true,
            user: row.config.user,
            password: secret,
          }).send({
            to: [row.from_address],
            from: row.from_address,
            subject: message.subject,
            text: message.text,
          });
        } else if (type === 'slack_webhook') {
          await createSlackSender(secret).send(message);
        } else {
          await createTeamsSender(secret).send(message);
        }
      } catch (err) {
        return fail(type, err instanceof Error ? err.message : 'delivery failed');
      }

      await db.withTenant(orgId, scope, (tx) =>
        audit.appendWithTx(tx, orgId, {
          actor,
          action: 'notification.channel.tested',
          target: row.id,
          data: { type },
        }),
      );
      return {
        object: 'notification.channel.test' as const,
        type,
        ok: true,
        detail:
          type === 'email_smtp'
            ? `Sent to ${row.from_address}.`
            : 'Posted. Check the channel it is wired to.',
      };
    },

    async listPreferences(orgId) {
      const rows = await db.withTenant(orgId, scope, (tx) => repo.listPreferences(tx, orgId));
      const stored = new Map(rows.map((r) => [r.event_type, r]));
      // The catalogue is the source of truth for WHICH events exist; a stored row only overrides
      // the default. That way a newly added event appears immediately with its default, instead of
      // being invisible until someone writes a preference for it.
      return EVENT_CATALOGUE.map((def) => toPreference(def.event, stored.get(def.event)));
    },

    async setPreference(actor, orgId, event, enabled, recipients) {
      const clean = recipients.map((r) => r.trim()).filter(Boolean);
      for (const address of clean) {
        if (!address.includes('@')) {
          throw new RelayError('invalid_request', {
            message: `'${address}' is not an email address.`,
            param: 'recipients',
          });
        }
      }

      const row = await db.withTenant(orgId, scope, async (tx) => {
        const saved = await repo.upsertPreference(tx, orgId, event, enabled, clean);
        await audit.appendWithTx(tx, orgId, {
          actor,
          action: 'notification.preference.updated',
          target: event,
          data: { enabled, recipients: clean.length },
        });
        return saved;
      });
      return toPreference(event, row);
    },

    async listOutbox(orgId, limit) {
      const rows = await db.withTenant(orgId, scope, (tx) => repo.listOutbox(tx, orgId, limit));
      return rows.map(toEntry);
    },

    // ── write side used by other modules ──────────────────────────────────────────────────────
    async enqueueWithTx(tx: Queryable, orgId: string, input: EnqueueInput) {
      await repo.enqueue(tx, orgId, input);
    },

    async enqueueDetached(orgId: string, input: EnqueueInput) {
      // Used by the data plane, which has no transaction to join. Best-effort by design: a
      // notification must never fail the request that triggered it.
      try {
        await db.withTenant(orgId, scope, (tx) => repo.enqueue(tx, orgId, input));
      } catch {
        // swallowed on purpose — see above
      }
    },
  };
}

const LABEL: Record<ChannelType, string> = {
  email_smtp: 'email',
  slack_webhook: 'Slack',
  msteams_webhook: 'Microsoft Teams',
};

function fail(type: ChannelType, detail: string): ChannelTestResult {
  return { object: 'notification.channel.test', type, ok: false, detail };
}

/**
 * Validate a channel save and return the new secret, or undefined when the caller is keeping the
 * stored one. Returning the secret rather than reaching for it twice keeps the plaintext on one
 * code path — it is sealed by the caller and never held anywhere else.
 */
function validateChannel(input: SetChannelInput): string | undefined {
  if (input.type === 'email_smtp') {
    if (!input.fromAddress.includes('@')) {
      throw new RelayError('invalid_request', {
        message: 'from_address must be an email address.',
        param: 'from_address',
      });
    }
    if (!input.host) {
      throw new RelayError('invalid_request', { message: 'host is required.', param: 'host' });
    }
    if (!Number.isInteger(input.port) || input.port <= 0 || input.port > 65535) {
      throw new RelayError('invalid_request', { message: 'port must be 1–65535.', param: 'port' });
    }
    return input.password || undefined;
  }

  const url = input.webhookUrl?.trim();
  if (!url) return undefined; // keep the stored URL (validated when it was first saved)

  const problem = checkWebhookUrl(input.type, url);
  if (problem) {
    throw new RelayError('invalid_request', { message: problem.message, param: 'webhook_url' });
  }
  return url;
}

/** Unseal a channel's stored secret, or null when it has none. */
function openChannelSecret(masterKey: string, row: ChannelRow): string | null {
  if (!row.ciphertext || !row.iv || !row.auth_tag || !row.wrapped_dek) return null;
  return openCredential(masterKey, {
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.auth_tag,
    wrappedDek: row.wrapped_dek,
  });
}

function toChannel(row: ChannelRow): Channel {
  return {
    object: 'notification.channel',
    id: row.id,
    type: row.type,
    from_address: row.from_address,
    host: row.config?.host ?? null,
    port: row.config?.port ?? null,
    secure: row.config?.secure ?? true,
    user: row.config?.user ?? null,
    // Webhook URLs are secret, so the wire carries only enough to recognise which one is wired up.
    // Recomputing the mask on read would need the plaintext, so it is derived from what is stored:
    // the presence of a secret plus the channel kind is all the console needs to render a state.
    target: row.type === 'email_smtp' ? null : row.ciphertext ? 'configured' : null,
    has_secret: row.ciphertext !== null,
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toPreference(event: NotificationEvent, row: PreferenceRow | undefined): Preference {
  const def = definitionFor(event);
  return {
    object: 'notification.preference',
    event_type: event,
    label: def?.label ?? event,
    description: def?.description ?? '',
    enabled: row ? row.enabled : (def?.defaultEnabled ?? false),
    recipients: row?.recipients ?? [],
  };
}

function toEntry(row: OutboxRow): OutboxEntry {
  return {
    object: 'notification',
    id: row.id,
    event_type: row.event_type,
    status: row.status,
    attempts: row.attempts,
    recipients: row.recipients,
    delivered_to: row.delivered_to ?? [],
    last_error: row.last_error,
    created_at: row.created_at,
    sent_at: row.sent_at,
  };
}
