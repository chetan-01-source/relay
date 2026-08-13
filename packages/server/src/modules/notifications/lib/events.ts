/**
 * Notification event catalogue — PURE, so the contract is unit-tested without a database.
 *
 * Every event a tenant can be notified about is declared here once: its id, its default on/off
 * state, and whether it deduplicates. Producers reference these constants rather than string
 * literals, so a typo is a compile error and the console's preference list cannot drift from what
 * the gateway actually emits.
 */

export const NOTIFICATION_EVENTS = [
  'budget.exceeded',
  'budget.threshold',
  'budget.updated',
  'member.joined',
  'member.removed',
  'key.revoked',
  'provider.deleted',
  'org.suspended',
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export interface EventDefinition {
  event: NotificationEvent;
  /** Shown in the console's preference list. */
  label: string;
  description: string;
  /**
   * Whether a tenant gets this by default. Spend and security events default ON because missing one
   * is expensive; routine configuration changes default OFF so the inbox stays worth reading.
   */
  defaultEnabled: boolean;
  /** True when the event is high-volume and MUST be deduplicated (see dedupeKeyFor). */
  deduped: boolean;
}

export const EVENT_CATALOGUE: readonly EventDefinition[] = [
  {
    event: 'budget.exceeded',
    label: 'Budget exceeded',
    description: 'A spend ceiling was reached and requests are being rejected.',
    defaultEnabled: true,
    deduped: true,
  },
  {
    event: 'budget.threshold',
    label: 'Budget at 80%',
    description: 'A spend ceiling is close to being reached, while there is still time to act.',
    defaultEnabled: true,
    deduped: true,
  },
  {
    event: 'budget.updated',
    label: 'Budget changed',
    description: 'A spend ceiling was created, changed or removed.',
    defaultEnabled: false,
    deduped: false,
  },
  {
    event: 'member.joined',
    label: 'Member joined',
    description: 'Someone accepted an invitation and joined the organization.',
    defaultEnabled: true,
    deduped: false,
  },
  {
    event: 'member.removed',
    label: 'Member removed',
    description: 'Someone was removed from the organization.',
    defaultEnabled: true,
    deduped: false,
  },
  {
    event: 'key.revoked',
    label: 'Virtual key revoked',
    description: 'A virtual key was revoked and can no longer be used.',
    defaultEnabled: true,
    deduped: false,
  },
  {
    event: 'provider.deleted',
    label: 'Provider credential deleted',
    description: 'An upstream credential was removed; routes targeting it will fail.',
    defaultEnabled: true,
    deduped: false,
  },
  {
    event: 'org.suspended',
    label: 'Organization suspended',
    description: 'The organization was suspended and its keys are being rejected.',
    defaultEnabled: true,
    deduped: false,
  },
];

/** Narrow an untrusted value (a preference row, an API body) to a known event. */
export function isNotificationEvent(value: string): value is NotificationEvent {
  return (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

export function definitionFor(event: NotificationEvent): EventDefinition | undefined {
  return EVENT_CATALOGUE.find((d) => d.event === event);
}

/**
 * The dedupe key for a high-volume event, or null when every occurrence deserves its own mail.
 *
 * This is what stops a tripped budget from mailing the org once per rejected request. `scope`
 * identifies the ceiling (org-wide or one application) and `window` the period stamp, so exactly one
 * notification is delivered per ceiling per period — and the next period mails again, because the
 * key changes with it.
 */
export function dedupeKeyFor(
  event: NotificationEvent,
  parts: { scope?: string; window?: string } = {},
): string | null {
  if (!definitionFor(event)?.deduped) return null;
  return [event, parts.scope ?? 'org', parts.window ?? 'all'].join(':');
}
