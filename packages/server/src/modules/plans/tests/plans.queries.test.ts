/**
 * Plans SQL. Entitlements decide what a tenant may create, so these queries sit directly behind the
 * quota gate — a wrong scope here is a tenant reading or spending against another tenant's plan.
 */
import { describe, expect, it } from 'vitest';
import {
  getPlanQuery,
  getSubscriptionQuery,
  listOrgFeaturesQuery,
  listPublicPlansQuery,
  upsertSubscriptionQuery,
  usageCountsQuery,
} from '../queries/plans.queries.js';

const ORG = '11111111-1111-1111-1111-111111111111';
const HOSTILE = "pro'; DROP TABLE org_subscriptions; --";

const SUBSCRIPTION_INPUT = {
  planCode: 'pro',
  status: null,
  trialEndsAt: null,
  graceUntil: null,
  currentPeriodEnd: null,
  overrides: null,
  provider: null,
  providerRef: null,
};

describe('plans queries', () => {
  it('binds every caller-supplied value as a parameter', () => {
    const queries = [
      getPlanQuery(HOSTILE),
      getSubscriptionQuery(HOSTILE),
      listOrgFeaturesQuery(HOSTILE),
      usageCountsQuery(HOSTILE, null),
      upsertSubscriptionQuery(HOSTILE, { ...SUBSCRIPTION_INPUT, planCode: HOSTILE }),
    ];
    for (const query of queries) {
      expect(query.text).not.toContain('DROP TABLE');
      expect(query.values).toContain(HOSTILE);
    }
  });

  it('fetches one plan by code', () => {
    const query = getPlanQuery('pro');
    expect(query.values).toEqual(['pro']);
  });

  it('lists only plans that are both public and still sold', () => {
    // The catalog is what a customer may buy. `public` alone is not enough — a retired plan stays
    // public so existing subscribers keep resolving, but it must not appear as a new option.
    const text = listPublicPlansQuery().text;
    expect(text).toContain('public = true');
    expect(text).toContain('active = true');
  });

  it('scopes the subscription read to one organization', () => {
    const query = getSubscriptionQuery(ORG);
    expect(query.text).toContain('org_id = $1');
    expect(query.values).toEqual([ORG]);
  });

  it('upserts a subscription rather than duplicating one per change', () => {
    const query = upsertSubscriptionQuery(ORG, SUBSCRIPTION_INPUT);
    expect(query.text).toContain('ON CONFLICT');
    expect(query.values[0]).toBe(ORG);
    // Defaults live in SQL so a partial update cannot blank a column it did not mean to touch.
    expect(query.text).toContain("COALESCE($3, 'active')");
  });

  it('counts every quota-bearing resource for one org', () => {
    const query = usageCountsQuery(ORG, null);
    for (const resource of ['applications', 'provider_credentials', 'routes', 'org_members']) {
      expect(query.text).toContain(resource);
    }
    // Each subquery is org-scoped: an unscoped count would let one tenant's usage consume another's
    // allowance.
    expect(query.text.match(/org_id = \$1/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('counts only ACTIVE keys, so rotating one does not consume the allowance', () => {
    const query = usageCountsQuery(ORG, '22222222-2222-2222-2222-222222222222');
    expect(query.text).toContain("status = 'active'");
    expect(query.values[1]).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('counts keys across the org when no application is named', () => {
    // `$2 IS NULL OR app_id = $2` — the null case must widen to the whole org, not match nothing.
    const query = usageCountsQuery(ORG, null);
    expect(query.text).toContain('$2::uuid IS NULL OR app_id = $2::uuid');
    expect(query.values[1]).toBeNull();
  });
});
