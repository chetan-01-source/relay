/**
 * Email transport. One interface, two implementations shipped — an API provider (Resend, SES) can be
 * added later as a third without touching the outbox, the dispatcher, or a single template.
 *
 * The default is deliberately the one that does NOT send. A developer testing a budget breach on a
 * laptop must not mail the tenant's real members; that has to be an explicit act of configuration,
 * not something that happens because a stack came up with credentials in scope.
 */
import { createTransport, type Transporter } from 'nodemailer';
import { teamsPayloadFormat } from '../lib/webhook-url.js';
import type { RenderedMessage } from '../lib/templates.js';

export interface EmailMessage {
  to: string[];
  from: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  /** Deliver, or throw. The dispatcher turns a throw into a retry with backoff. */
  send(message: EmailMessage): Promise<void>;
  /** Identifies the transport in logs and in the delivery record. */
  readonly kind: string;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
}

/** Real delivery. One transport per settings object; the dispatcher builds these per tenant. */
export function createSmtpSender(settings: SmtpSettings): EmailSender {
  const transport: Transporter = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    ...(settings.user ? { auth: { user: settings.user, pass: settings.password ?? '' } } : {}),
  });

  return {
    kind: `smtp:${settings.host}`,
    async send(message) {
      await transport.sendMail({
        from: message.from,
        to: message.to.join(', '),
        subject: message.subject,
        text: message.text,
      });
    },
  };
}

// ── Chat webhooks (Slack, Microsoft Teams) ──────────────────────────────────────────────────────
//
// A chat channel is not a mailbox: there are no recipients to resolve, because the webhook URL IS
// the destination. So these take the rendered message and nothing else, and the dispatcher never
// asks who should receive them.

/** How long the gateway will wait on a webhook before treating it as failed. */
const WEBHOOK_TIMEOUT_MS = 10_000;

export interface WebhookSender {
  /** Post the message, or throw. The dispatcher turns a throw into a retry with backoff. */
  send(message: RenderedMessage): Promise<void>;
  readonly kind: string;
}

/**
 * POST JSON to a webhook and insist on a 2xx.
 *
 * The timeout is not optional. The dispatcher runs deliveries in sequence, so one webhook host that
 * accepts a connection and then never answers would stall every other tenant's notifications behind
 * it. A body excerpt rides along on failure because Slack and Teams both explain themselves in the
 * response body (`invalid_token`, `Bad payload`) while using a bare status for everything.
 */
async function postJson(kind: string, url: string, body: unknown): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (err) {
    // The URL is a secret, so it must never reach an error string — the delivery log is readable by
    // anyone in the org, and last_error is stored in Postgres.
    const reason = err instanceof Error ? err.message : 'request failed';
    throw new Error(`${kind} webhook unreachable: ${reason}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`${kind} webhook rejected the message: ${response.status} ${detail}`.trim());
  }
}

/**
 * Slack incoming webhook. `text` carries the whole message: the subject as a bold first line, then
 * the body. Slack's mrkdwn is a subset of Markdown — `*bold*`, single asterisks — and the templates
 * emit plain text, so nothing else needs escaping.
 */
export function createSlackSender(webhookUrl: string): WebhookSender {
  return {
    kind: 'slack',
    send(message) {
      return postJson('Slack', webhookUrl, {
        text: `*${message.subject}*\n\n${message.text}`,
      });
    },
  };
}

/**
 * Microsoft Teams. Two incompatible payload shapes are in the wild and the URL says which to use
 * (see teamsPayloadFormat): retiring Office 365 connectors take a MessageCard, Power Automate
 * Workflows take an Adaptive Card. Posting the wrong one yields an empty card rather than an error,
 * so the choice is made from the host instead of asked of the tenant.
 */
export function createTeamsSender(webhookUrl: string): WebhookSender {
  return {
    kind: 'msteams',
    send(message) {
      const body =
        teamsPayloadFormat(webhookUrl) === 'message_card'
          ? {
              '@type': 'MessageCard',
              '@context': 'https://schema.org/extensions',
              summary: message.subject,
              themeColor: '0F62FE',
              title: message.subject,
              // MessageCard renders Markdown, where a single newline is not a break.
              text: message.text.replace(/\n/g, '\n\n'),
            }
          : {
              type: 'message',
              attachments: [
                {
                  contentType: 'application/vnd.microsoft.card.adaptive',
                  content: {
                    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                    type: 'AdaptiveCard',
                    version: '1.4',
                    body: [
                      {
                        type: 'TextBlock',
                        text: message.subject,
                        weight: 'Bolder',
                        size: 'Medium',
                        wrap: true,
                      },
                      { type: 'TextBlock', text: message.text, wrap: true },
                    ],
                  },
                },
              ],
            };
      return postJson('Teams', webhookUrl, body);
    },
  };
}

/**
 * The safe default: records what WOULD have been sent and returns success.
 *
 * Returning success rather than throwing is intentional — a dev stack should show notifications
 * flowing through to `sent` in the console so the whole pipeline is observable, without a byte
 * leaving the machine.
 */
export function createConsoleSender(log: (line: string) => void = () => {}): EmailSender {
  return {
    kind: 'console',
    send(message) {
      log(
        `[notifications] (not sent — no SMTP configured) to=${message.to.join(',')} subject=${message.subject}`,
      );
      return Promise.resolve();
    },
  };
}
