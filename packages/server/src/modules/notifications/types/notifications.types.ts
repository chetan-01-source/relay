/**
 * Notifications module contracts. The module owns three things: what a tenant wants to be told
 * (preferences), how to reach them (channels), and the durable record of every attempt (outbox).
 */
import type { Queryable } from '../../../platform/db.js';
import type { NotificationEvent } from '../lib/events.js';
import type { EventPayload } from '../lib/templates.js';

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'suppressed';

/**
 * The ways a tenant can be reached. Email is a mailbox — it needs a sender and a recipient list;
 * the two chat kinds are webhooks, where the URL alone names the destination. Everything downstream
 * (validation, the wire shape, delivery) branches on exactly this.
 */
export type ChannelType = 'email_smtp' | 'slack_webhook' | 'msteams_webhook';

export const CHANNEL_TYPES: readonly ChannelType[] = [
  'email_smtp',
  'slack_webhook',
  'msteams_webhook',
];

export function isChannelType(value: string): value is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(value);
}

export interface ChannelRow {
  id: string;
  org_id: string;
  type: ChannelType;
  /** SMTP envelope From; null for webhook channels, which have no sender. */
  from_address: string | null;
  ciphertext: Buffer | null;
  iv: Buffer | null;
  auth_tag: Buffer | null;
  wrapped_dek: Buffer | null;
  config: SmtpConfig;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** Non-secret SMTP settings. The password lives in the sealed columns, never here. */
export interface SmtpConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
}

/**
 * Channel as returned on the wire. It never carries the secret — not the SMTP password and not the
 * webhook URL, which is itself a bearer credential. `target` is a masked hint (`hooks.slack.com/…mnop`)
 * so an operator can tell WHICH webhook is wired up without being able to post to it.
 */
export interface Channel {
  object: 'notification.channel';
  id: string;
  type: ChannelType;
  from_address: string | null;
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  target: string | null;
  /** True when a secret is sealed for this channel. The value itself is never returned. */
  has_secret: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface SetEmailChannelInput {
  type: 'email_smtp';
  fromAddress: string;
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  /** Omitted on an update ⇒ keep the stored secret. */
  password?: string;
  enabled: boolean;
}

export interface SetWebhookChannelInput {
  type: 'slack_webhook' | 'msteams_webhook';
  /** Omitted on an update ⇒ keep the stored URL, so toggling `enabled` needn't re-paste the secret. */
  webhookUrl?: string;
  enabled: boolean;
}

export type SetChannelInput = SetEmailChannelInput | SetWebhookChannelInput;

export interface PreferenceRow {
  id: string;
  org_id: string;
  event_type: string;
  enabled: boolean;
  recipients: string[];
  created_at: string;
  updated_at: string;
}

export interface Preference {
  object: 'notification.preference';
  event_type: string;
  label: string;
  description: string;
  enabled: boolean;
  recipients: string[];
}

/** Outcome of a test send — `ok: false` carries the transport's own complaint, not a generic one. */
export interface ChannelTestResult {
  object: 'notification.channel.test';
  type: ChannelType;
  ok: boolean;
  detail: string;
}

export interface OutboxRow {
  id: string;
  org_id: string;
  event_type: string;
  payload: EventPayload;
  dedupe_key: string | null;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  recipients: string[];
  /** Channel types already delivered to; a retry skips these. */
  delivered_to: string[];
  created_at: string;
  sent_at: string | null;
}

/** One delivery-log entry as the console renders it. */
export interface OutboxEntry {
  object: 'notification';
  id: string;
  event_type: string;
  status: OutboxStatus;
  attempts: number;
  recipients: string[];
  delivered_to: string[];
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface EnqueueInput {
  event: NotificationEvent;
  payload: EventPayload;
  /** Collapses repeats of one logical event; null ⇒ every occurrence is its own notification. */
  dedupeKey: string | null;
}

export interface NotificationsRepository {
  // ── channels ──
  getChannel(tx: Queryable, orgId: string, type: ChannelType): Promise<ChannelRow | null>;
  listChannels(tx: Queryable, orgId: string): Promise<ChannelRow[]>;
  upsertChannel(
    tx: Queryable,
    orgId: string,
    input: SetChannelInput,
    sealed: SealedSecret | null,
  ): Promise<ChannelRow>;
  deleteChannel(tx: Queryable, orgId: string, type: ChannelType): Promise<boolean>;

  // ── preferences ──
  listPreferences(tx: Queryable, orgId: string): Promise<PreferenceRow[]>;
  upsertPreference(
    tx: Queryable,
    orgId: string,
    event: string,
    enabled: boolean,
    recipients: string[],
  ): Promise<PreferenceRow>;

  // ── outbox ──
  /** Insert a pending row. Returns false when a dedupe key already claimed this logical event. */
  enqueue(tx: Queryable, orgId: string, input: EnqueueInput): Promise<boolean>;
  listOutbox(tx: Queryable, orgId: string, limit: number): Promise<OutboxRow[]>;
}

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  wrappedDek: Buffer;
}

export interface NotificationsService {
  getChannel(orgId: string, type: ChannelType): Promise<Channel | null>;
  listChannels(orgId: string): Promise<Channel[]>;
  setChannel(actor: string, orgId: string, input: SetChannelInput): Promise<Channel>;
  deleteChannel(actor: string, orgId: string, type: ChannelType): Promise<void>;
  /**
   * Send a real message through one configured channel, right now.
   *
   * Worth an endpoint of its own because every failure mode here is invisible until something goes
   * wrong at 3am: a webhook revoked in Slack, an SMTP password rotated, a Teams flow deleted. The
   * result is returned rather than thrown so the console can show the provider's own words.
   */
  testChannel(actor: string, orgId: string, type: ChannelType): Promise<ChannelTestResult>;
  listPreferences(orgId: string): Promise<Preference[]>;
  setPreference(
    actor: string,
    orgId: string,
    event: NotificationEvent,
    enabled: boolean,
    recipients: string[],
  ): Promise<Preference>;
  listOutbox(orgId: string, limit: number): Promise<OutboxEntry[]>;
}

/**
 * The write side other modules use. `enqueueWithTx` takes the CALLER's transaction so the
 * notification commits atomically with the change that caused it — the same contract as
 * audit.appendWithTx, and for the same reason.
 */
export interface NotificationEnqueuer {
  enqueueWithTx(tx: Queryable, orgId: string, input: EnqueueInput): Promise<void>;
  /** For producers with no transaction to join (the data plane). Best-effort, never throws. */
  enqueueDetached(orgId: string, input: EnqueueInput): Promise<void>;
}
