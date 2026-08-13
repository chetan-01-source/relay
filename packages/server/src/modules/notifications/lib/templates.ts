/**
 * Message rendering — PURE, so every template is unit-tested without sending anything.
 *
 * Plain text only, deliberately. These are operational alerts read on a phone at an awkward hour;
 * HTML buys nothing and costs deliverability, and a text body cannot leak an injection through a
 * mail client. Values are interpolated as text, never as markup.
 */
import type { NotificationEvent } from './events.js';

export interface RenderedMessage {
  subject: string;
  text: string;
}

/** The payload a producer attaches. Every field is optional — a template renders what it is given. */
export interface EventPayload {
  orgName?: string;
  scope?: string; // 'organization' or an application name
  period?: string; // 'daily' | 'monthly'
  limitUsd?: number;
  spentUsd?: number;
  percent?: number;
  actor?: string;
  target?: string;
  detail?: string;
  consoleUrl?: string;
}

function money(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'n/a';
  // Matches the console's formatter: small LLM costs need real precision or they read as $0.00.
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

function footer(payload: EventPayload): string {
  return payload.consoleUrl
    ? `\n\nManage this in the console: ${payload.consoleUrl}\nTo stop receiving this, change your notification preferences there.`
    : '\n\nChange your notification preferences in the Relay console.';
}

/** Render one event into a subject + body. Unknown events get a safe generic message rather than
 * throwing — a producer added ahead of its template must not break delivery for everything else. */
export function render(event: NotificationEvent, payload: EventPayload): RenderedMessage {
  const org = payload.orgName ?? 'your organization';
  const scope = payload.scope ?? 'organization';

  switch (event) {
    case 'budget.exceeded':
      return {
        subject: `[Relay] ${scope} ${payload.period ?? ''} budget exceeded`.replace(/\s+/g, ' '),
        text:
          `The ${payload.period ?? ''} spend ceiling for ${scope} in ${org} has been reached.\n\n` +
          `Limit:  ${money(payload.limitUsd)}\n` +
          `Spent:  ${money(payload.spentUsd)}\n\n` +
          `Requests are now being rejected with budget_exceeded. Raise the limit or wait for the ` +
          `period to reset.` +
          footer(payload),
      };

    case 'budget.threshold':
      return {
        subject:
          `[Relay] ${scope} ${payload.period ?? ''} budget at ${payload.percent ?? 80}%`.replace(
            /\s+/g,
            ' ',
          ),
        text:
          `The ${payload.period ?? ''} spend ceiling for ${scope} in ${org} is ${payload.percent ?? 80}% used.\n\n` +
          `Limit:  ${money(payload.limitUsd)}\n` +
          `Spent:  ${money(payload.spentUsd)}\n\n` +
          `Requests are still being served. This is a warning while there is time to act.` +
          footer(payload),
      };

    case 'budget.updated':
      return {
        subject: `[Relay] Budget changed for ${scope}`,
        text:
          `${payload.actor ?? 'Someone'} changed the ${payload.period ?? ''} spend ceiling for ` +
          `${scope} in ${org}.\n\n${payload.detail ?? ''}`.trim() +
          footer(payload),
      };

    case 'member.joined':
      return {
        subject: `[Relay] ${payload.target ?? 'A new member'} joined ${org}`,
        text: `${payload.target ?? 'A new member'} joined ${org}.` + footer(payload),
      };

    case 'member.removed':
      return {
        subject: `[Relay] ${payload.target ?? 'A member'} was removed from ${org}`,
        text:
          `${payload.target ?? 'A member'} was removed from ${org}` +
          `${payload.actor ? ` by ${payload.actor}` : ''}. Their access ends immediately.` +
          footer(payload),
      };

    case 'key.revoked':
      return {
        subject: `[Relay] Virtual key revoked in ${org}`,
        text:
          `A virtual key was revoked${payload.actor ? ` by ${payload.actor}` : ''} in ${org}.\n\n` +
          `Key: ${payload.target ?? 'unknown'}\n\n` +
          `Any client still using it will now be rejected.` +
          footer(payload),
      };

    case 'provider.deleted':
      return {
        subject: `[Relay] Provider credential deleted in ${org}`,
        text:
          `The provider credential ${payload.target ?? ''} was deleted` +
          `${payload.actor ? ` by ${payload.actor}` : ''} in ${org}.\n\n` +
          `Any route still targeting it will fail at request time.` +
          footer(payload),
      };

    case 'org.suspended':
      return {
        subject: `[Relay] ${org} has been suspended`,
        text:
          `${org} has been suspended. All of its virtual keys are being rejected.\n\n` +
          `Contact your platform administrator to restore access.` +
          footer(payload),
      };

    default:
      // Exhaustiveness is checked at compile time; this only runs if a new event ships without a
      // template. Sending something generic beats dropping the notification silently.
      return {
        subject: `[Relay] ${String(event)}`,
        text: `An event (${String(event)}) occurred in ${org}.` + footer(payload),
      };
  }
}
