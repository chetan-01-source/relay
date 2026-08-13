/**
 * Service-level behaviour that a pure-function test cannot reach: quota rejection, capability gates,
 * read-time trial expiry, and the promise that the oss edition never limits anybody.
 *
 * The database is faked at the repository boundary — the point here is the decision logic, not SQL.
 */
import { describe, expect, it } from 'vitest';
import { isRelayError } from '@relay/shared';
import type { Database, Queryable } from '../../../platform/db.js';
import { createPlansService } from '../services/plans.service.js';
import { createUnlimitedPlansService } from '../services/unlimited.service.js';
import type {
  PlanRow,
  PlansRepository,
  QuotaUsage,
  SubscriptionRow,
} from '../types/plans.types.js';

const NO_USAGE: QuotaUsage = {
  'apps.max': 0,
  'providers.max': 0,
  'routes.max': 0,
  'members.max': 0,
  'keys.per_app.max': 0,
};

const TX = {} as Queryable;

function plan(code: string, limits: Record<string, unknown>, tier = 1): PlanRow {
  return {
    code,
    name: code,
    description: '',
    tier,
    limits,
    price_monthly_usd: '0',
    price_yearly_usd: '0',
    public: true,
    active: true,
  };
}

function fakeDb(): Database {
  return {
    run: () => Promise.resolve([]),
    withTenant: <T>(_org: string, _scope: unknown, fn: (tx: Queryable) => Promise<T>) => fn(TX),
    ping: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
}

function fakeRepo(input: {
  plans: PlanRow[];
  subscription?: SubscriptionRow | null;
  features?: Array<{ feature_key: string; value: unknown }>;
  usage?: Partial<QuotaUsage>;
}): PlansRepository {
  return {
    getPlan: (_tx, code) => Promise.resolve(input.plans.find((p) => p.code === code) ?? null),
    listPublicPlans: () => Promise.resolve(input.plans),
    getSubscription: () => Promise.resolve(input.subscription ?? null),
    upsertSubscription: () => Promise.reject(new Error('not used')),
    listFeatures: () => Promise.resolve(input.features ?? []),
    usage: () => Promise.resolve({ ...NO_USAGE, ...input.usage }),
  };
}

const audit = { appendWithTx: () => Promise.resolve() } as never;

function subscription(over: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    id: 'sub-1',
    org_id: 'org-1',
    plan_code: 'pro',
    status: 'active',
    trial_ends_at: null,
    grace_until: null,
    current_period_start: null,
    current_period_end: null,
    overrides: {},
    provider: null,
    provider_ref: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

/** Run fn and return the RelayError it threw, failing loudly if it threw something else — or nothing. */
async function thrown(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    if (isRelayError(err)) return err;
    throw err;
  }
  throw new Error('expected a RelayError, but the call resolved');
}

const FREE = plan('free', { 'apps.max': 1, 'cache.exact': false }, 1);
const PRO = plan('pro', { 'apps.max': 10, 'cache.exact': true }, 2);

describe('assertQuota', () => {
  it('allows a create while under the ceiling', async () => {
    const service = createPlansService({
      db: fakeDb(),
      audit,
      repo: fakeRepo({
        plans: [FREE, PRO],
        subscription: subscription({ plan_code: 'pro' }),
        usage: { 'apps.max': 9 },
      }),
    });
    await expect(service.assertQuota(TX, 'org-1', 'apps.max')).resolves.toBeUndefined();
  });

  it('rejects at the ceiling with quota_exceeded naming the limit', async () => {
    const service = createPlansService({
      db: fakeDb(),
      audit,
      repo: fakeRepo({
        plans: [FREE, PRO],
        subscription: subscription({ plan_code: 'pro' }),
        usage: { 'apps.max': 10 },
      }),
    });
    const err = await thrown(() => service.assertQuota(TX, 'org-1', 'apps.max'));
    expect(err.code).toBe('quota_exceeded');
    expect(err.status).toBe(409);
    expect(err.param).toBe('apps.max');
    // The message has to say what to DO, not name a jsonb key.
    expect(err.message).toContain('10 applications');
  });

  it('never rejects when the plan sets the limit to null', async () => {
    const service = createPlansService({
      db: fakeDb(),
      audit,
      repo: fakeRepo({
        plans: [plan('enterprise', { 'apps.max': null })],
        subscription: subscription({ plan_code: 'enterprise' }),
        usage: { 'apps.max': 9_999 },
      }),
    });
    await expect(service.assertQuota(TX, 'org-1', 'apps.max')).resolves.toBeUndefined();
  });

  it('honours a per-contract override over the plan', async () => {
    const service = createPlansService({
      db: fakeDb(),
      audit,
      repo: fakeRepo({
        plans: [FREE, PRO],
        subscription: subscription({ plan_code: 'pro', overrides: { 'apps.max': 40 } }),
        usage: { 'apps.max': 20 },
      }),
    });
    await expect(service.assertQuota(TX, 'org-1', 'apps.max')).resolves.toBeUndefined();
  });
});

describe('assertFeature', () => {
  it('rejects a capability the plan excludes', async () => {
    const service = createPlansService({
      db: fakeDb(),
      audit,
      repo: fakeRepo({ plans: [FREE], subscription: subscription({ plan_code: 'free' }) }),
    });
    const err = await thrown(() => service.assertFeature('org-1', 'cache.exact'));
    expect(err.code).toBe('plan_upgrade_required');
    expect(err.status).toBe(403);
    expect(err.param).toBe('cache.exact');
  });

  it('lets an org_features row switch a capability back on for one tenant', async () => {
    const service = createPlansService({
      db: fakeDb(),
      audit,
      repo: fakeRepo({
        plans: [FREE],
        subscription: subscription({ plan_code: 'free' }),
        features: [{ feature_key: 'cache.exact', value: true }],
      }),
    });
    await expect(service.assertFeature('org-1', 'cache.exact')).resolves.toBeUndefined();
  });
});

describe('read-time lapse', () => {
  const past = '2020-01-01T00:00:00Z';
  const future = '2999-01-01T00:00:00Z';

  it('keeps paid limits while a trial is still running', async () => {
    const service = createPlansService({
      db: fakeDb(),
      audit,
      repo: fakeRepo({
        plans: [FREE, PRO],
        subscription: subscription({ plan_code: 'pro', status: 'trialing', trial_ends_at: future }),
      }),
    });
    const effective = await service.effectiveFor('org-1');
    expect(effective.lapsed).toBe(false);
    expect(effective.limits['apps.max'].value).toBe(10);
  });

  it('falls back to the free plan the moment a trial expires — no cron involved', async () => {
    const service = createPlansService({
      db: fakeDb(),
      audit,
      repo: fakeRepo({
        plans: [FREE, PRO],
        subscription: subscription({ plan_code: 'pro', status: 'trialing', trial_ends_at: past }),
      }),
    });
    const effective = await service.effectiveFor('org-1');
    expect(effective.limits['apps.max'].value).toBe(1);
    // The row still reports the real state, so the console can explain WHY rather than silently
    // showing Free.
    expect(effective.status).toBe('trialing');
    expect(effective.planCode).toBe('pro');
    expect(effective.lapsed).toBe(true);
  });

  it('keeps paid limits for a past_due subscription inside its grace window', async () => {
    const service = createPlansService({
      db: fakeDb(),
      audit,
      repo: fakeRepo({
        plans: [FREE, PRO],
        subscription: subscription({ plan_code: 'pro', status: 'past_due', grace_until: future }),
      }),
    });
    expect((await service.effectiveFor('org-1')).limits['apps.max'].value).toBe(10);
  });

  it('drops a lapsed subscription’s negotiated overrides with it', async () => {
    const service = createPlansService({
      db: fakeDb(),
      audit,
      repo: fakeRepo({
        plans: [FREE, PRO],
        subscription: subscription({
          plan_code: 'pro',
          status: 'canceled',
          overrides: { 'apps.max': 40 },
        }),
      }),
    });
    expect((await service.effectiveFor('org-1')).limits['apps.max'].value).toBe(1);
  });

  it('falls back rather than throwing when the named plan row has gone', async () => {
    const service = createPlansService({
      db: fakeDb(),
      audit,
      repo: fakeRepo({ plans: [FREE], subscription: subscription({ plan_code: 'deleted' }) }),
    });
    // A missing catalog row must not 500 the hot path.
    await expect(service.effectiveFor('org-1')).resolves.toBeDefined();
  });
});

describe('the oss edition', () => {
  const service = createUnlimitedPlansService({
    db: fakeDb(),
    repo: fakeRepo({ plans: [], usage: { 'apps.max': 10_000 } }),
  });

  it('never rejects a quota, however much is in use', async () => {
    await expect(service.assertQuota(TX, 'org-1', 'apps.max')).resolves.toBeUndefined();
    await expect(service.assertQuota(TX, 'org-1', 'members.max')).resolves.toBeUndefined();
  });

  it('never gates a capability', async () => {
    await expect(service.assertFeature('org-1', 'cache.exact')).resolves.toBeUndefined();
    await expect(service.assertFeature('org-1', 'modalities.image')).resolves.toBeUndefined();
  });

  it('imposes no rate or spend ceiling on the snapshot', async () => {
    const ceilings = await service.ceilingsIn(TX, 'org-1');
    expect(ceilings).toMatchObject({ rpm: null, tpm: null, monthlySpendUsd: null });
    expect(ceilings.planCode).toBe('self_hosted');
  });

  it('still reports real usage counts, so the plan page is useful without ceilings', async () => {
    expect((await service.usageFor('org-1'))['apps.max']).toBe(10_000);
  });

  it('offers no catalog to buy from', async () => {
    expect(await service.listCatalog()).toEqual([]);
  });
});
