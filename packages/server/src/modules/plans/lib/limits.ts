/**
 * The closed limit vocabulary (ADR-0014). `plans.limits` and `org_subscriptions.overrides` are jsonb
 * so pricing can change without a migration — this file is what stops that flexibility from becoming
 * a free-for-all. Every key a plan may carry is declared here, with its kind, and anything else in
 * the column is ignored by the resolver.
 *
 * PURE: no IO, no database, no Fastify. Everything here is a value and a function over values, which
 * is what makes the resolution rules directly testable.
 *
 * Two conventions carry most of the weight:
 *   • `null` on a numeric limit means UNLIMITED — not "unset", not zero. That is what lets the
 *     self-hosted plan be "all nulls, all flags true" instead of a special case in code.
 *   • Precedence is most-specific-wins: plan → subscription overrides → org_features.
 */

/** Countable resources. Enforced inside the transaction that inserts the row (never in a preHandler
 * — that races: two concurrent creates on a 10-app plan would both observe 9). */
export const COUNT_LIMIT_KEYS = [
  'apps.max',
  'providers.max',
  'routes.max',
  'keys.per_app.max',
  'members.max',
] as const;

/** Hot-path ceilings folded into the virtual-key snapshot and enforced by modules/policy. */
export const RATE_LIMIT_KEYS = ['rate.rpm', 'rate.tpm'] as const;

/** A monthly org-wide spend ceiling the plan imposes IN ADDITION to whatever the org sets itself. */
export const SPEND_LIMIT_KEYS = ['spend.monthly_usd.max'] as const;

/**
 * How long the request feed is kept, enforced by the metering module's prune worker.
 *
 * There is deliberately NO `retention.audit_days`. The audit trail is hash-chained and append-only
 * (ADR-0010): deleting old entries would break `POST /api/v1/audit/verify` for everything after
 * them, so audit retention is not something a plan may shorten. Selling a shorter audit window would
 * mean selling a broken verify endpoint.
 */
export const RETENTION_LIMIT_KEYS = ['retention.traffic_days'] as const;

/**
 * Boolean capability gates. Every one of these has exactly one enforcement point — see docs/plans.md
 * §3. A flag with no enforcement point does not belong in this list; an unenforced switch in the
 * console is worse than no switch.
 *
 * `sso.enforced` is NOT here for exactly that reason: enforcing single sign-on is Logto
 * configuration, not a gateway decision, so the gateway has nowhere to honour such a flag. It stays
 * a commercial term of the Enterprise plan rather than a limit key that pretends to be enforced.
 */
export const FEATURE_LIMIT_KEYS = [
  'cache.exact',
  'routing.failover',
  'modalities.image',
  'notifications.chat',
  'analytics.export',
] as const;

export const NUMERIC_LIMIT_KEYS = [
  ...COUNT_LIMIT_KEYS,
  ...RATE_LIMIT_KEYS,
  ...SPEND_LIMIT_KEYS,
  ...RETENTION_LIMIT_KEYS,
] as const;

export const LIMIT_KEYS = [...NUMERIC_LIMIT_KEYS, ...FEATURE_LIMIT_KEYS] as const;

export type CountLimitKey = (typeof COUNT_LIMIT_KEYS)[number];
export type NumericLimitKey = (typeof NUMERIC_LIMIT_KEYS)[number];
export type FeatureLimitKey = (typeof FEATURE_LIMIT_KEYS)[number];
export type LimitKey = (typeof LIMIT_KEYS)[number];

/** A numeric ceiling (`null` = unlimited) or a capability flag. */
export type LimitValue = number | null | boolean;

/** A partial limit map, as stored in `plans.limits` / `org_subscriptions.overrides`. */
export type LimitMap = Partial<Record<LimitKey, LimitValue>>;

/** Where an effective value came from. Rendered by the console so nobody has to recall precedence. */
export type LimitSource = 'plan' | 'override' | 'org_feature' | 'default';

export interface ResolvedLimit {
  value: LimitValue;
  source: LimitSource;
}

/** Every key resolved, with provenance. Keys are always present — an absent key resolves to its
 * default rather than to `undefined`, so no consumer has to handle a hole. */
export type ResolvedLimits = Record<LimitKey, ResolvedLimit>;

/**
 * What a key means when nothing has an opinion about it.
 *
 * Numeric defaults are `null` (unlimited) and feature defaults are `true` — the permissive end on
 * purpose. A limit only ever binds because a plan explicitly said so, which means a new key added to
 * this file cannot silently start rejecting traffic for orgs on plans that predate it.
 */
export function defaultFor(key: LimitKey): LimitValue {
  return isFeatureKey(key) ? true : null;
}

export function isFeatureKey(key: LimitKey): key is FeatureLimitKey {
  return (FEATURE_LIMIT_KEYS as readonly string[]).includes(key);
}

export function isCountKey(key: string): key is CountLimitKey {
  return (COUNT_LIMIT_KEYS as readonly string[]).includes(key);
}

export function isLimitKey(key: string): key is LimitKey {
  return (LIMIT_KEYS as readonly string[]).includes(key);
}

/** `null`/`undefined` on a numeric limit means no ceiling. */
export function isUnlimited(value: LimitValue): boolean {
  return value === null || value === undefined;
}

/**
 * Coerce a stored jsonb value to the type its key promises, or return undefined so the layer below
 * wins. A malformed value must NOT resolve to `false`/`0` — that would turn a typo in an overrides
 * blob into a production outage. Ignoring it and falling through is the safe failure.
 */
function coerce(key: LimitKey, raw: unknown): LimitValue | undefined {
  if (raw === null) return null; // an explicit "unlimited"
  if (isFeatureKey(key)) return typeof raw === 'boolean' ? raw : undefined;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return undefined;
}

/** Keep only the declared, well-typed keys from a stored jsonb blob. */
export function sanitizeLimits(raw: unknown): LimitMap {
  const out: LimitMap = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isLimitKey(key)) continue;
    const coerced = coerce(key, value);
    if (coerced !== undefined) out[key] = coerced;
  }
  return out;
}

/**
 * `org_features` stores arbitrary jsonb per flag and predates this vocabulary. Only rows whose key is
 * a declared limit participate in resolution; anything else stays available in the raw entitlement
 * map for a consumer that knows about it, exactly as before.
 */
export function featuresToLimits(features: Record<string, unknown>): LimitMap {
  return sanitizeLimits(features);
}

/**
 * Resolve one effective map from the three layers, most specific wins.
 *
 *   plan.limits  ⊕  subscription.overrides  ⊕  org_features
 *
 * `org_features` sits on top deliberately: it is the lever support reaches for when one customer
 * needs one flag on at 2am, it is already wired into the console's matrix editor and its own
 * invalidation channel, and putting the plan underneath it means this whole layer is additive —
 * nothing changes for an org whose flags already match its plan.
 */
export function resolveLimits(input: {
  plan: LimitMap;
  overrides?: LimitMap;
  features?: LimitMap;
}): ResolvedLimits {
  const out = {} as ResolvedLimits;
  for (const key of LIMIT_KEYS) {
    const feature = input.features?.[key];
    const override = input.overrides?.[key];
    const plan = input.plan[key];
    if (feature !== undefined) out[key] = { value: feature, source: 'org_feature' };
    else if (override !== undefined) out[key] = { value: override, source: 'override' };
    else if (plan !== undefined) out[key] = { value: plan, source: 'plan' };
    else out[key] = { value: defaultFor(key), source: 'default' };
  }
  return out;
}

/** Flatten to plain values — the shape the hot path and the entitlement map want. */
export function flatten(resolved: ResolvedLimits): Record<LimitKey, LimitValue> {
  const out = {} as Record<LimitKey, LimitValue>;
  for (const key of LIMIT_KEYS) out[key] = resolved[key].value;
  return out;
}

/** Every limit unlimited, every capability on — the self-hosted plan, expressed in code. */
export function unlimitedLimits(): LimitMap {
  const out: LimitMap = {};
  for (const key of LIMIT_KEYS) out[key] = defaultFor(key);
  return out;
}

/**
 * Compose a plan ceiling with a limit the org set for itself: the TIGHTER of the two wins, and a
 * `null` on either side means that side has no opinion.
 *
 * Minimum rather than maximum is what makes a downgrade safe. An org on Scale with `rpm = 6000` that
 * moves to Pro does not need its configuration rewritten — enforcement simply tightens to 600. The
 * console shows both numbers and marks which is binding.
 */
export function tighter(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** Numeric view of a resolved key. Returns null for unlimited, and for a key that is not numeric. */
export function numeric(resolved: ResolvedLimits, key: NumericLimitKey): number | null {
  const value = resolved[key]?.value;
  return typeof value === 'number' ? value : null;
}

/** Boolean view of a resolved capability. */
export function enabled(resolved: ResolvedLimits, key: FeatureLimitKey): boolean {
  return resolved[key]?.value !== false;
}
