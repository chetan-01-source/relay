/**
 * Plan presentation helpers — PURE, so the plan page stays a server component with no client JS and
 * every formatting rule is unit-testable (docs/plans.md · ADR-0014).
 *
 * The gateway returns limits as `{ value, source, used? }`. Everything a human needs on top of that —
 * "is this a ceiling or a switch", "how full is it", "where did the number come from", "is the org
 * already over" — is decided here, once, rather than inline in JSX where it would drift between the
 * quota list and the entitlement list.
 */
import type { EffectivePlan } from './api';

/** The countable quotas, in the order an operator reads them: what you build with, then who's in. */
export const QUOTA_KEYS = [
  'apps.max',
  'providers.max',
  'routes.max',
  'keys.per_app.max',
  'members.max',
] as const;

/** Ceilings that bind traffic rather than objects. Shown as values, not meters — they have no "used". */
export const THROUGHPUT_KEYS = ['rate.rpm', 'rate.tpm', 'spend.monthly_usd.max'] as const;

export const FEATURE_KEYS = [
  'cache.exact',
  'routing.failover',
  'modalities.image',
  'notifications.chat',
  'analytics.export',
] as const;

export const RETENTION_KEYS = ['retention.traffic_days'] as const;

export type PlanLimitKey =
  | (typeof QUOTA_KEYS)[number]
  | (typeof THROUGHPUT_KEYS)[number]
  | (typeof FEATURE_KEYS)[number]
  | (typeof RETENTION_KEYS)[number];

/** Human labels. The key is the API contract; this is what a person should read. */
export const LIMIT_LABEL: Record<PlanLimitKey, string> = {
  'apps.max': 'Applications',
  'providers.max': 'Provider credentials',
  'routes.max': 'Routes',
  'keys.per_app.max': 'Active keys per application',
  'members.max': 'Members',
  'rate.rpm': 'Requests per minute',
  'rate.tpm': 'Tokens per minute',
  'spend.monthly_usd.max': 'Monthly spend ceiling',
  'retention.traffic_days': 'Request-feed retention',
  'cache.exact': 'Response caching',
  'routing.failover': 'Routing failover',
  'modalities.image': 'Image inputs',
  'notifications.chat': 'Slack & Teams alerts',
  'analytics.export': 'Analytics export',
};

/** One line of prose per limit, so nobody has to open the docs to know what a row means. */
export const LIMIT_HINT: Record<PlanLimitKey, string> = {
  'apps.max': 'Each application owns its own virtual keys, routes and budgets.',
  'providers.max': 'Sealed upstream credentials — one per provider account.',
  'routes.max': 'Model aliases that fan out to an ordered set of targets.',
  'keys.per_app.max': 'Revoked keys do not count; rotating never consumes a slot.',
  'members.max': 'People who can sign in to this organization.',
  'rate.rpm': 'Enforced per key with a token bucket; bursts smooth out within the minute.',
  'rate.tpm': 'Estimated from the request before the upstream call, then settled.',
  'spend.monthly_usd.max': 'A hard cutoff the gateway applies on top of your own budgets.',
  'retention.traffic_days':
    'How long individual requests stay inspectable. Spend history is kept in full.',
  'cache.exact': 'Identical requests are served from Valkey without touching a provider.',
  'routing.failover': 'A dead provider fails over to the next target inside the same request.',
  'modalities.image': 'Image content parts in chat messages.',
  'notifications.chat':
    'Budget and key alerts delivered to Slack or Microsoft Teams. Email is always included.',
  'analytics.export': 'Download usage and spend as CSV.',
};

export type LimitSource = 'plan' | 'override' | 'org_feature' | 'default';

export interface ResolvedLimit {
  value?: number | boolean | null;
  source?: string;
  used?: number;
}

export interface QuotaRow {
  key: PlanLimitKey;
  label: string;
  hint: string;
  used: number;
  /** null = unlimited. */
  limit: number | null;
  /** 0–1, or null when there is no ceiling to be a fraction of. */
  ratio: number | null;
  source: LimitSource;
  /** At or past the ceiling: creating the next one will be refused. */
  exhausted: boolean;
  /** Past the ceiling — only reachable after a downgrade, and worth calling out explicitly. */
  over: boolean;
}

const NEAR_FULL = 0.8;

/** Matches the amber threshold the budget bar and the gateway's own warning use. One meaning, one number. */
export function isNearFull(ratio: number | null): boolean {
  return ratio !== null && ratio >= NEAR_FULL && ratio < 1;
}

export function limitOf(plan: EffectivePlan, key: PlanLimitKey): ResolvedLimit {
  const limits = (plan as { limits?: Record<string, ResolvedLimit> }).limits ?? {};
  return limits[key] ?? {};
}

export function sourceOf(limit: ResolvedLimit): LimitSource {
  const source = limit.source;
  return source === 'override' || source === 'org_feature' || source === 'default'
    ? source
    : 'plan';
}

/** Where a number came from, in words. Rendered beside the value so precedence never has to be recalled. */
export function sourceLabel(source: LimitSource): string {
  switch (source) {
    case 'override':
      return 'Custom for this organization';
    case 'org_feature':
      return 'Set by an administrator';
    case 'default':
      return 'No limit configured';
    default:
      return 'From your plan';
  }
}

export function isEnabled(plan: EffectivePlan, key: PlanLimitKey): boolean {
  // Absent means "nobody has an opinion", which is permissive — matching the gateway's own default.
  return limitOf(plan, key).value !== false;
}

export function quotaRows(plan: EffectivePlan): QuotaRow[] {
  return QUOTA_KEYS.map((key) => {
    const limit = limitOf(plan, key);
    const ceiling = typeof limit.value === 'number' ? limit.value : null;
    const used = typeof limit.used === 'number' ? limit.used : 0;
    return {
      key,
      label: LIMIT_LABEL[key],
      hint: LIMIT_HINT[key],
      used,
      limit: ceiling,
      ratio: ceiling === null || ceiling === 0 ? null : Math.min(1, used / ceiling),
      source: sourceOf(limit),
      exhausted: ceiling !== null && used >= ceiling,
      over: ceiling !== null && used > ceiling,
    };
  });
}

/**
 * Format a ceiling for display. `null` is "Unlimited", not "0" and not an em-dash: on the
 * self-hosted edition every row is null, and a page of dashes reads like a page of missing data.
 */
export function formatLimit(key: PlanLimitKey, value: number | boolean | null | undefined): string {
  if (typeof value === 'boolean') return value ? 'Included' : 'Not included';
  if (value === null || value === undefined) return 'Unlimited';
  if (key === 'spend.monthly_usd.max') return formatUsd(value);
  if (key === 'retention.traffic_days') return `${value} ${value === 1 ? 'day' : 'days'}`;
  return formatCount(value);
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

/** Monthly price, or null for a plan quoted on request. */
export function formatPrice(monthly: number | null | undefined): string | null {
  if (monthly === null || monthly === undefined) return null;
  return monthly === 0 ? 'Free' : formatUsd(monthly);
}

export interface PlanStatusNote {
  tone: 'neutral' | 'warning';
  message: string;
}

/**
 * The one-line explanation of an unusual subscription state.
 *
 * Returns null when everything is ordinary — a banner that is always present stops being read. The
 * `lapsed` cases are the ones that matter: the gateway is already enforcing the free tier while the
 * subscription still says Pro, and a customer seeing tightened limits deserves to know why rather
 * than filing a bug.
 */
export function statusNote(plan: EffectivePlan): PlanStatusNote | null {
  const status = (plan as { status?: string }).status;
  const lapsed = (plan as { lapsed?: boolean }).lapsed === true;
  const trialEndsAt = (plan as { trial_ends_at?: string | null }).trial_ends_at ?? null;

  if (lapsed && status === 'trialing') {
    return {
      tone: 'warning',
      message: `Your trial ended${trialEndsAt ? ` on ${formatDate(trialEndsAt)}` : ''}. Free-plan limits are being enforced.`,
    };
  }
  if (lapsed && status === 'past_due') {
    return {
      tone: 'warning',
      message:
        'Payment is overdue and the grace period has ended. Free-plan limits are being enforced.',
    };
  }
  if (lapsed && status === 'canceled') {
    return {
      tone: 'warning',
      message: 'This subscription was cancelled. Free-plan limits are being enforced.',
    };
  }
  if (status === 'trialing' && trialEndsAt) {
    return { tone: 'neutral', message: `Trial — full limits until ${formatDate(trialEndsAt)}.` };
  }
  if (status === 'past_due') {
    return {
      tone: 'warning',
      message: 'Payment is overdue. Your current limits continue during the grace period.',
    };
  }
  return null;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}
