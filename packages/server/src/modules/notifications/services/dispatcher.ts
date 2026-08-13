/**
 * Delivery worker. Claims due notifications, resolves how to reach the tenant, renders, sends, and
 * records the outcome — then sleeps.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, so running several gateway workers scales delivery instead
 * of making them fight over the head of the queue. The claim flips the row to `sending` in the same
 * statement, so a crash mid-send leaves a visible in-flight row rather than a duplicate email.
 *
 * Failure is never fatal here: a tenant with a broken SMTP config, or a Postgres blip, must not take
 * the gateway down. Everything degrades to a retry or a recorded `failed`.
 */
import { openCredential } from '../../../platform/crypto.js';
import type { Database } from '../../../platform/db.js';
import type { LogtoOrgSync } from '../../../platform/logto.js';
import {
  claimDueQuery,
  markSentQuery,
  markDeliveredToQuery,
  markRetryQuery,
  markSuppressedQuery,
  loadOrgNameQuery,
  loadDeliveryChannelsQuery,
  getPreferenceQuery,
} from '../queries/notifications.queries.js';
import { backoffSeconds, isDead } from '../lib/backoff.js';
import { definitionFor, isNotificationEvent } from '../lib/events.js';
import { render } from '../lib/templates.js';
import {
  createSmtpSender,
  createSlackSender,
  createTeamsSender,
  type EmailSender,
} from './sender.js';
import type { ChannelType, OutboxRow, SmtpConfig } from '../types/notifications.types.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** One configured channel, straight from the row, with its sealed secret still sealed. */
interface DeliveryChannelRow {
  type: ChannelType;
  from_address: string | null;
  config: SmtpConfig | null;
  ciphertext: Buffer | null;
  iv: Buffer | null;
  auth_tag: Buffer | null;
  wrapped_dek: Buffer | null;
}

export interface DispatcherDeps {
  db: Database;
  masterKey: string;
  /** Fallback transport when a tenant has configured none. Defaults to the console (no-send) sender. */
  platformSender: EmailSender;
  /** From address for the platform sender. */
  platformFrom: string;
  /** Resolves org members to recipient addresses. Absent ⇒ only explicit recipients are used. */
  logto?: LogtoOrgSync | undefined;
  batchSize?: number;
  intervalMs?: number;
  consoleUrl?: string | undefined;
}

export interface Dispatcher {
  /** Process one batch. Exposed for tests and for a manual drain; returns how many were handled. */
  tick(): Promise<number>;
  start(): void;
  stop(): void;
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const batchSize = deps.batchSize ?? 20;
  const intervalMs = deps.intervalMs ?? 15_000;
  const platformScope = { isPlatformAdmin: true };
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  /** Claim across ALL tenants, so this reads as a platform admin — a cross-org read by design. */
  async function claim(): Promise<OutboxRow[]> {
    return deps.db.withTenant(NIL_UUID, platformScope, (tx) =>
      tx.run<OutboxRow>(claimDueQuery(batchSize)),
    );
  }

  async function tick(): Promise<number> {
    let rows: OutboxRow[];
    try {
      rows = await claim();
    } catch {
      return 0; // a database blip is not worth crashing the worker over; the next tick retries
    }

    for (const row of rows) {
      try {
        await deliver(row);
      } catch (err) {
        await recordFailure(row, err);
      }
    }
    return rows.length;
  }

  /**
   * Deliver one notification to every channel that has not already received it.
   *
   * Channels fail independently — Slack can be down while SMTP is fine — so a failure is recorded
   * against the row while the successes are persisted in `delivered_to`. The retry then resumes
   * instead of repeating, which is what stops one broken webhook from re-mailing the whole org on
   * every attempt.
   */
  async function deliver(row: OutboxRow): Promise<void> {
    if (!isNotificationEvent(row.event_type)) {
      await suppress(row, `unknown event type '${row.event_type}'`);
      return;
    }

    const [org] = await deps.db.withTenant(row.org_id, platformScope, (tx) =>
      tx.run<{ org_name: string }>(loadOrgNameQuery(row.org_id)),
    );
    if (!org) {
      await suppress(row, 'organization no longer exists');
      return;
    }

    // A tenant that switched this event off gets nothing — recorded as suppressed rather than
    // deleted, so the log still shows the event happened and why nothing went out.
    const [preference] = await deps.db.withTenant(row.org_id, platformScope, (tx) =>
      tx.run<{ enabled: boolean; recipients: string[] }>(
        getPreferenceQuery(row.org_id, row.event_type),
      ),
    );
    const enabled = preference?.enabled ?? definitionFor(row.event_type)?.defaultEnabled ?? false;
    if (!enabled) {
      await suppress(row, 'event disabled in notification preferences');
      return;
    }

    const channels = await deps.db.withTenant(row.org_id, platformScope, (tx) =>
      tx.run<DeliveryChannelRow>(loadDeliveryChannelsQuery(row.org_id)),
    );
    const message = render(row.event_type, {
      ...row.payload,
      orgName: org.org_name,
      ...(deps.consoleUrl ? { consoleUrl: deps.consoleUrl } : {}),
    });

    const already = new Set(row.delivered_to ?? []);
    const delivered = [...already];
    const failures: string[] = [];
    let recipients = row.recipients ?? [];

    // ── chat webhooks ───────────────────────────────────────────────────────────────────────────
    // No recipients to resolve: the webhook URL is the destination. A tenant with only Slack
    // configured is still reachable even though nobody's mailbox is involved.
    for (const channel of channels) {
      if (channel.type === 'email_smtp' || already.has(channel.type)) continue;
      const url = openSecret(channel);
      if (!url) {
        failures.push(`${channel.type}: no webhook URL stored`);
        continue;
      }
      const sender =
        channel.type === 'slack_webhook' ? createSlackSender(url) : createTeamsSender(url);
      try {
        await sender.send(message);
        delivered.push(channel.type);
      } catch (err) {
        failures.push(`${channel.type}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }

    // ── email ───────────────────────────────────────────────────────────────────────────────────
    // Attempted whenever there is somebody to send to, using the tenant's own SMTP if configured and
    // the platform sender otherwise. An empty recipient list is only fatal when nothing else could
    // deliver either — a tenant that wired up Slack alone has not misconfigured anything.
    if (!already.has('email_smtp')) {
      const emailChannel = channels.find((c) => c.type === 'email_smtp');
      const resolved = await resolveRecipients(row.org_id, preference?.recipients ?? []);
      if (resolved.length > 0) {
        recipients = resolved;
        const { sender, from } = resolveSender(emailChannel);
        try {
          await sender.send({ to: resolved, from, subject: message.subject, text: message.text });
          delivered.push('email_smtp');
        } catch (err) {
          failures.push(`email: ${err instanceof Error ? err.message : 'failed'}`);
        }
      } else if (channels.length === 0) {
        // No chat channel and nobody to mail: there is genuinely no way to reach this tenant.
        await suppress(row, 'no recipients (no org members with an email, and none configured)');
        return;
      }
    }

    if (delivered.length === 0 && failures.length === 0) {
      await suppress(row, 'no channel could deliver this notification');
      return;
    }

    if (failures.length > 0) {
      // Persist what DID land before the retry is scheduled, or the next attempt repeats it.
      await deps.db.withTenant(row.org_id, platformScope, (tx) =>
        tx.run(markDeliveredToQuery(row.id, recipients, delivered)),
      );
      throw new Error(failures.join('; '));
    }

    await deps.db.withTenant(row.org_id, platformScope, (tx) =>
      tx.run(markSentQuery(row.id, recipients, delivered)),
    );
  }

  /** Unseal a channel's stored secret, or null when it has none. */
  function openSecret(channel: DeliveryChannelRow): string | null {
    if (!channel.ciphertext || !channel.iv || !channel.auth_tag || !channel.wrapped_dek)
      return null;
    return openCredential(deps.masterKey, {
      ciphertext: channel.ciphertext,
      iv: channel.iv,
      authTag: channel.auth_tag,
      wrappedDek: channel.wrapped_dek,
    });
  }

  /**
   * A tenant's own SMTP wins; otherwise the platform default. This is the "set your own creds, or
   * use ours" contract — configuring SMTP is an override, never a prerequisite.
   */
  function resolveSender(channel: DeliveryChannelRow | undefined): {
    sender: EmailSender;
    from: string;
  } {
    const config = channel?.config;
    const password = channel ? openSecret(channel) : null;
    if (channel?.from_address && config?.host && config.port && password) {
      return {
        sender: createSmtpSender({
          host: config.host,
          port: config.port,
          secure: config.secure ?? true,
          user: config.user,
          password,
        }),
        from: channel.from_address,
      };
    }
    return { sender: deps.platformSender, from: channel?.from_address ?? deps.platformFrom };
  }

  /** Org members from Logto, plus any explicitly configured addresses, de-duplicated. */
  async function resolveRecipients(orgId: string, extra: string[]): Promise<string[]> {
    const addresses = new Set(extra.map((a) => a.trim()).filter(Boolean));
    if (deps.logto) {
      try {
        const [org] = await deps.db.withTenant(orgId, platformScope, (tx) =>
          tx.run<{ logto_org_id: string }>({
            text: 'SELECT logto_org_id FROM organizations WHERE id = $1',
            values: [orgId],
          }),
        );
        if (org) {
          for (const member of await deps.logto.listMembers(org.logto_org_id)) {
            if (member.email) addresses.add(member.email);
          }
        }
      } catch {
        // Logto unavailable — fall back to the explicitly configured addresses rather than dropping
        // the notification entirely.
      }
    }
    return [...addresses];
  }

  async function suppress(row: OutboxRow, reason: string): Promise<void> {
    await deps.db.withTenant(row.org_id, platformScope, (tx) =>
      tx.run(markSuppressedQuery(row.id, reason)),
    );
  }

  async function recordFailure(row: OutboxRow, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : 'delivery failed';
    // `attempts` was already incremented by the claim, so it reflects the attempt just spent.
    const dead = isDead(row.attempts);
    try {
      await deps.db.withTenant(row.org_id, platformScope, (tx) =>
        tx.run(markRetryQuery(row.id, message, backoffSeconds(row.attempts), dead)),
      );
    } catch {
      // If we cannot even record the failure the row stays 'sending' and a later sweep will surface
      // it; losing the gateway over a notification would be far worse.
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return; // never overlap ticks — a slow SMTP server must not stack workers
        running = true;
        void tick().finally(() => {
          running = false;
        });
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
