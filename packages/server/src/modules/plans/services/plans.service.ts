/**
 * Plans service — the table-backed implementation (cloud edition). Resolves an org's effective
 * limits, answers quota and capability questions, and owns the subscription lifecycle.
 *
 * Three things make this more than CRUD:
 *
 * 1. **Trials and lapses expire on READ.** A `trialing` subscription whose `trial_ends_at` has
 *    passed resolves to the free plan's limits immediately, everywhere, with no scheduled job and
 *    no window where an expired trial still holds paid ceilings because a worker was restarting.
 *    The row keeps its real status so the console can say "your trial ended on the 3rd".
 * 2. **Quota checks run inside the caller's transaction.** `assertQuota` takes a `Queryable`, not an
 *    org id, precisely so the count and the insert it guards are the same transaction. Checking in a
 *    preHandler reads better and races: two concurrent creates on a 10-app plan both observe 9.
 * 3. **Invalidation.** Limits are folded into every virtual-key snapshot, which workers cache in
 *    process. A subscription write that only touched Postgres would leave the data plane enforcing
 *    the previous plan until an entry happened to be evicted, so every mutation publishes on the
 *    policy channel and workers drop their snapshots within ~1s.
 *
 * No SQL and no HTTP live here. Every mutation is audited inside the same transaction as the write.
 */
import { RelayError } from 'relay-shared';
import type { Database, Queryable } from '../../../platform/db.js';
import type { EventBus } from '../../../platform/eventbus.js';
import { planRejections } from '../../../platform/metrics.js';
import type { AuditRepository } from '../../audit/index.js';
import { publishOrgPolicyUpdated } from '../../identity/index.js';
import {
  enabled,
  featuresToLimits,
  flatten,
  isUnlimited,
  numeric,
  resolveLimits,
  sanitizeLimits,
  type CountLimitKey,
  type FeatureLimitKey,
} from '../lib/limits.js';
import type {
  EffectivePlan,
  PlanCatalogEntry,
  PlanCeilings,
  PlanRow,
  PlansRepository,
  PlansService,
  QuotaUsage,
  Subscription,
  SubscriptionRow,
} from '../types/plans.types.js';

/** Where an org with no subscription row lands, and where a lapsed one falls back to. */
const DEFAULT_PLAN_CODE = 'free';

/** Human wording for each quota, so the 409 says what to do instead of naming a jsonb key. */
const QUOTA_NOUN: Record<CountLimitKey, string> = {
  'apps.max': 'applications',
  'providers.max': 'provider credentials',
  'routes.max': 'routes',
  'keys.per_app.max': 'active keys in this application',
  'members.max': 'members',
};

const FEATURE_NOUN: Record<FeatureLimitKey, string> = {
  'cache.exact': 'Response caching',
  'routing.failover': 'Routing failover',
  'modalities.image': 'Image inputs',
  'notifications.chat': 'Slack and Teams notifications',
  'analytics.export': 'Analytics export',
};

export interface PlansServiceDeps {
  db: Database;
  repo: PlansRepository;
  audit: AuditRepository;
  bus?: EventBus; // absent offline (the OpenAPI dump) — publishing is then skipped
}

export function createPlansService(deps: PlansServiceDeps): PlansService {
  const { db, repo, audit, bus } = deps;
  const scope = { isPlatformAdmin: false };
  // Reading the catalog and writing a subscription cross the tenant boundary (the catalog has no
  // org, and a platform admin assigns plans to orgs they are not a member of).
  const platform = { isPlatformAdmin: true };
  const NIL_UUID = '00000000-0000-0000-0000-000000000000';

  /**
   * The heart of the module: three layers → one resolved map.
   *
   * A missing plan row is NOT an error. A subscription can name a plan that was later deleted, and
   * a gateway that 500s on the hot path because a catalog row went missing is worse than one that
   * falls back to the default tier and keeps serving.
   */
  async function resolve(tx: Queryable, orgId: string): Promise<EffectivePlan> {
    const subscription = await repo.getSubscription(tx, orgId);
    const code = subscription?.plan_code ?? DEFAULT_PLAN_CODE;
    const plan = (await repo.getPlan(tx, code)) ?? (await repo.getPlan(tx, DEFAULT_PLAN_CODE));

    const lapsed = subscription ? hasLapsed(subscription) : false;
    // A lapsed subscription is entitled to the default plan, not to nothing: cutting a tenant's
    // gateway dead over a card decline is a worse failure than serving them at free-tier limits.
    const effectivePlan = lapsed ? await repo.getPlan(tx, DEFAULT_PLAN_CODE) : plan;

    const features = await repo.listFeatures(tx, orgId);
    const featureMap: Record<string, unknown> = {};
    for (const row of features) featureMap[row.feature_key] = row.value;

    const limits = resolveLimits({
      plan: sanitizeLimits(effectivePlan?.limits),
      // Per-contract overrides die with the subscription's paid state — otherwise a lapsed
      // enterprise agreement would keep its negotiated seat count forever.
      ...(lapsed ? {} : { overrides: sanitizeLimits(subscription?.overrides) }),
      features: featuresToLimits(featureMap),
    });

    return {
      planCode: plan?.code ?? DEFAULT_PLAN_CODE,
      planName: plan?.name ?? 'Free',
      tier: plan?.tier ?? 0,
      status: subscription?.status ?? 'active',
      lapsed,
      trialEndsAt: subscription?.trial_ends_at ?? null,
      currentPeriodEnd: subscription?.current_period_end ?? null,
      limits,
    };
  }

  async function effectiveFor(orgId: string): Promise<EffectivePlan> {
    return db.withTenant(orgId, scope, (tx) => resolve(tx, orgId));
  }

  return {
    effectiveFor,
    effectiveIn: resolve,

    async ceilingsIn(tx, orgId): Promise<PlanCeilings> {
      const effective = await resolve(tx, orgId);
      return {
        planCode: effective.planCode,
        entitlements: flatten(effective.limits),
        rpm: numeric(effective.limits, 'rate.rpm'),
        tpm: numeric(effective.limits, 'rate.tpm'),
        monthlySpendUsd: numeric(effective.limits, 'spend.monthly_usd.max'),
      };
    },

    async assertQuota(tx, orgId, key, quotaScope) {
      const effective = await resolve(tx, orgId);
      const ceiling = numeric(effective.limits, key);
      if (isUnlimited(ceiling)) return;

      const usage = await repo.usage(tx, orgId, quotaScope);
      const used = usage[key];
      if (used < ceiling!) return;

      planRejections.inc({ limit: key, kind: 'quota' });
      throw new RelayError('quota_exceeded', {
        param: key,
        message:
          `Plan ${effective.planCode} allows ${ceiling} ${QUOTA_NOUN[key]}; ` +
          `this organization has ${used}. Remove one or move to a larger plan.`,
      });
    },

    async assertFeature(orgId, key) {
      await db.withTenant(orgId, scope, async (tx) => {
        await assertFeatureIn(tx, orgId, key);
      });
    },

    assertFeatureIn,

    usageIn: (tx, orgId, quotaScope) => repo.usage(tx, orgId, quotaScope),

    usageFor(orgId, quotaScope): Promise<QuotaUsage> {
      return db.withTenant(orgId, scope, (tx) => repo.usage(tx, orgId, quotaScope));
    },

    async listCatalog(): Promise<PlanCatalogEntry[]> {
      const rows = await db.withTenant(NIL_UUID, platform, (tx) => repo.listPublicPlans(tx));
      return rows.map(toCatalogEntry);
    },

    async getSubscription(orgId) {
      const row = await db.withTenant(orgId, scope, (tx) => repo.getSubscription(tx, orgId));
      return row ? toSubscription(row) : null;
    },

    async setSubscription(actor, orgId, input) {
      const row = await db.withTenant(orgId, platform, async (tx) => {
        await requirePlan(tx, input.planCode, { purchasableOnly: false });
        const previous = await repo.getSubscription(tx, orgId);
        const saved = await repo.upsertSubscription(tx, orgId, input);
        await audit.appendWithTx(tx, orgId, {
          actor,
          action: previous ? 'plan.change' : 'plan.assign',
          target: saved.id,
          data: {
            plan_code: saved.plan_code,
            status: saved.status,
            ...(previous ? { previous_plan_code: previous.plan_code } : {}),
            ...(input.overrides ? { overrides: input.overrides } : {}),
          },
        });
        return saved;
      });
      await announce(orgId);
      return toSubscription(row);
    },

    async changePlan(actor, orgId, planCode) {
      const row = await db.withTenant(orgId, scope, async (tx) => {
        // Self-serve may only move between plans that are actually on sale. A tenant must not be
        // able to name `self_hosted` (unlimited, not public) and grant itself everything.
        await requirePlan(tx, planCode, { purchasableOnly: true });
        const previous = await repo.getSubscription(tx, orgId);
        const saved = await repo.upsertSubscription(tx, orgId, {
          planCode,
          status: 'active',
        });
        await audit.appendWithTx(tx, orgId, {
          actor,
          action: 'plan.change',
          target: saved.id,
          data: {
            plan_code: planCode,
            self_serve: true,
            ...(previous ? { previous_plan_code: previous.plan_code } : {}),
          },
        });
        return saved;
      });
      await announce(orgId);
      return toSubscription(row);
    },
  };

  async function assertFeatureIn(
    tx: Queryable,
    orgId: string,
    key: FeatureLimitKey,
  ): Promise<void> {
    const effective = await resolve(tx, orgId);
    if (enabled(effective.limits, key)) return;
    planRejections.inc({ limit: key, kind: 'feature' });
    throw new RelayError('plan_upgrade_required', {
      param: key,
      message: `${FEATURE_NOUN[key]} is not included in plan ${effective.planCode}.`,
    });
  }

  async function requirePlan(
    tx: Queryable,
    code: string,
    opts: { purchasableOnly: boolean },
  ): Promise<PlanRow> {
    const plan = await repo.getPlan(tx, code);
    if (!plan || (opts.purchasableOnly && !(plan.public && plan.active))) {
      throw new RelayError('not_found', { message: `No such plan: ${code}.`, param: 'plan_code' });
    }
    return plan;
  }

  /** Drop every worker's cached snapshot for this org so the new plan takes effect at once. */
  async function announce(orgId: string): Promise<void> {
    if (bus) await publishOrgPolicyUpdated(bus, orgId);
  }
}

/**
 * Has the subscription stopped entitling its plan?
 *
 * Read-time expiry — no cron. Each arm answers a different failure: a trial that ran out, a payment
 * that failed past its grace window, and an explicit cancellation.
 */
function hasLapsed(row: SubscriptionRow, now: Date = new Date()): boolean {
  if (row.status === 'canceled') return true;
  if (row.status === 'trialing') {
    return row.trial_ends_at !== null && new Date(row.trial_ends_at) <= now;
  }
  if (row.status === 'past_due') {
    // No grace window recorded means the grace has not been granted — lapse immediately.
    return row.grace_until === null || new Date(row.grace_until) <= now;
  }
  return false;
}

function toCatalogEntry(row: PlanRow): PlanCatalogEntry {
  return {
    object: 'plan',
    code: row.code,
    name: row.name,
    description: row.description,
    tier: row.tier,
    price_monthly_usd: row.price_monthly_usd === null ? null : Number(row.price_monthly_usd),
    price_yearly_usd: row.price_yearly_usd === null ? null : Number(row.price_yearly_usd),
    limits: sanitizeLimits(row.limits),
  };
}

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    object: 'subscription',
    org_id: row.org_id,
    plan_code: row.plan_code,
    status: row.status,
    trial_ends_at: row.trial_ends_at,
    grace_until: row.grace_until,
    current_period_end: row.current_period_end,
    overrides: sanitizeLimits(row.overrides),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
