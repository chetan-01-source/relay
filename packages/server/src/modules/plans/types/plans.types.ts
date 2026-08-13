/**
 * Plans module contracts (ADR-0014). A plan names the limits an organization is entitled to; this
 * module resolves the effective set, reports usage against it, and is the ONLY place that decides
 * whether a quota rejects.
 *
 * Every layer depends on an interface declared here.
 */
import type { Queryable } from '../../../platform/db.js';
import type {
  CountLimitKey,
  FeatureLimitKey,
  LimitMap,
  LimitValue,
  ResolvedLimits,
} from '../lib/limits.js';

/** Mirrors the CHECK in migration 0018. */
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';

export interface PlanRow {
  code: string;
  name: string;
  description: string;
  tier: number;
  limits: unknown; // jsonb — sanitized through lib/limits before use
  price_monthly_usd: string | null; // numeric arrives from pg as text
  price_yearly_usd: string | null;
  public: boolean;
  active: boolean;
}

export interface SubscriptionRow {
  id: string;
  org_id: string;
  plan_code: string;
  status: SubscriptionStatus;
  trial_ends_at: string | null;
  grace_until: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  overrides: unknown; // jsonb
  provider: string | null;
  provider_ref: string | null;
  created_at: string;
  updated_at: string;
}

/** A purchasable plan as the catalog API returns it. */
export interface PlanCatalogEntry {
  object: 'plan';
  code: string;
  name: string;
  description: string;
  tier: number;
  price_monthly_usd: number | null;
  price_yearly_usd: number | null;
  limits: Record<string, LimitValue>;
}

/** An org's subscription as the API returns it. */
export interface Subscription {
  object: 'subscription';
  org_id: string;
  plan_code: string;
  status: SubscriptionStatus;
  trial_ends_at: string | null;
  grace_until: string | null;
  current_period_end: string | null;
  overrides: Record<string, LimitValue>;
  created_at: string;
  updated_at: string;
}

/**
 * The fully resolved answer to "what may this org do". `lapsed` is true when the subscription's own
 * dates mean the paid limits no longer apply (an expired trial, a past_due beyond its grace window,
 * a cancellation) — in which case `limits` already holds the free plan's values while `status` still
 * reports the real state, so the console can explain WHY rather than silently showing Free.
 */
export interface EffectivePlan {
  planCode: string;
  planName: string;
  tier: number;
  status: SubscriptionStatus;
  lapsed: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  limits: ResolvedLimits;
}

/** Current consumption of every countable quota. `keysInApp` is scoped to one application. */
export interface QuotaUsage {
  'apps.max': number;
  'providers.max': number;
  'routes.max': number;
  'members.max': number;
  'keys.per_app.max': number;
}

/** Narrows a count to one application, for `keys.per_app.max`. */
export interface QuotaScope {
  appId?: string;
}

/**
 * What the identity module needs from a plan when it builds a virtual-key snapshot: the flags, the
 * rate ceiling and the implicit monthly spend ceiling. Deliberately NOT the whole EffectivePlan —
 * identity should not have to know the plan vocabulary to fold this in.
 */
export interface PlanCeilings {
  planCode: string;
  /** Plan-derived feature flags, to be merged UNDER the org's own org_features rows. */
  entitlements: Record<string, LimitValue>;
  rpm: number | null;
  tpm: number | null;
  /** Monthly org-wide USD ceiling the plan imposes, or null for unlimited. */
  monthlySpendUsd: number | null;
}

/** Data-access boundary. The ONLY layer that touches the database. */
export interface PlansRepository {
  getPlan(tx: Queryable, code: string): Promise<PlanRow | null>;
  listPublicPlans(tx: Queryable): Promise<PlanRow[]>;
  getSubscription(tx: Queryable, orgId: string): Promise<SubscriptionRow | null>;
  upsertSubscription(
    tx: Queryable,
    orgId: string,
    input: SetSubscriptionInput,
  ): Promise<SubscriptionRow>;
  /** The org's entitlement flags — the same rows identity reads, needed here for provenance. */
  listFeatures(
    tx: Queryable,
    orgId: string,
  ): Promise<Array<{ feature_key: string; value: unknown }>>;
  /**
   * Current consumption of every countable quota, in ONE round trip.
   *
   * This is the one place the plans module reads other modules' tables. The alternative — every
   * module publishing a counter — buys nothing: the count has to be taken inside the same
   * transaction as the insert it guards, so it has to be a query, and putting five `SELECT count(*)`
   * statements behind one interface is the smaller coupling.
   */
  usage(tx: Queryable, orgId: string, scope?: QuotaScope): Promise<QuotaUsage>;
}

export interface SetSubscriptionInput {
  planCode: string;
  status?: SubscriptionStatus;
  trialEndsAt?: string | null;
  graceUntil?: string | null;
  currentPeriodEnd?: string | null;
  overrides?: LimitMap;
  provider?: string | null;
  providerRef?: string | null;
}

/**
 * Business boundary. Two implementations exist and the composition root picks one from
 * `RELAY_EDITION` (see docs/editions.md):
 *
 *   cloud → createPlansService()      table-backed; quotas and gates bite
 *   oss   → createUnlimitedPlans()    every limit null, every flag true; asserts never throw
 *
 * Call sites never branch on the edition — they ask the service, and against the unlimited one the
 * question returns immediately.
 */
export interface PlansService {
  /** Resolve in a fresh tenant transaction. */
  effectiveFor(orgId: string): Promise<EffectivePlan>;
  /** Resolve inside a transaction the caller already owns (snapshot build, quota check). */
  effectiveIn(tx: Queryable, orgId: string): Promise<EffectivePlan>;
  /** The subset identity folds into a virtual-key snapshot. */
  ceilingsIn(tx: Queryable, orgId: string): Promise<PlanCeilings>;

  /**
   * Throw `quota_exceeded` when the org has already reached its ceiling for `key`.
   *
   * MUST be called inside the same transaction as the insert it guards — outside it, two concurrent
   * creates on a 10-app plan both observe 9 and both succeed.
   */
  assertQuota(tx: Queryable, orgId: string, key: CountLimitKey, scope?: QuotaScope): Promise<void>;

  /** Throw `plan_upgrade_required` when a capability is not included in the org's plan. */
  assertFeature(orgId: string, key: FeatureLimitKey): Promise<void>;
  assertFeatureIn(tx: Queryable, orgId: string, key: FeatureLimitKey): Promise<void>;

  usageIn(tx: Queryable, orgId: string, scope?: QuotaScope): Promise<QuotaUsage>;
  usageFor(orgId: string, scope?: QuotaScope): Promise<QuotaUsage>;

  listCatalog(): Promise<PlanCatalogEntry[]>;
  getSubscription(orgId: string): Promise<Subscription | null>;
  /** Platform-admin write: assign a plan, set overrides, extend a trial. */
  setSubscription(actor: string, orgId: string, input: SetSubscriptionInput): Promise<Subscription>;
  /** Org-admin self-serve change. Rejects a plan that is not public+active. */
  changePlan(actor: string, orgId: string, planCode: string): Promise<Subscription>;
}
