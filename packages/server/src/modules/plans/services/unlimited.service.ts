/**
 * The self-hosted plan, expressed as a service (docs/editions.md).
 *
 * This is what `RELAY_EDITION=oss` — the default — resolves EVERY organization to: every numeric
 * limit `null`, every capability `true`, every assertion a no-op. It is not a stub or a test double;
 * it is the honest open-source entitlement, and the whole OSS test suite runs against it.
 *
 * Putting the edition switch here rather than at call sites is what keeps `assertQuota()` reading
 * identically in both editions: enforcement code asks the service a question, and against this
 * implementation the answer returns immediately without touching the plans tables at all.
 *
 * Usage COUNTS are still real. A self-hoster's plan page reports how many applications, providers,
 * routes, keys and members exist — useful capacity information — with no ceiling beside it.
 */
import { RelayError } from '@relay/shared';
import type { Database } from '../../../platform/db.js';
import { resolveLimits, unlimitedLimits, flatten } from '../lib/limits.js';
import type {
  EffectivePlan,
  PlanCeilings,
  PlansRepository,
  PlansService,
} from '../types/plans.types.js';

export const SELF_HOSTED_PLAN_CODE = 'self_hosted';

export interface UnlimitedPlansDeps {
  db: Database;
  repo: PlansRepository;
}

function selfHosted(): EffectivePlan {
  return {
    planCode: SELF_HOSTED_PLAN_CODE,
    planName: 'Self-hosted',
    tier: 0,
    status: 'active',
    lapsed: false,
    trialEndsAt: null,
    currentPeriodEnd: null,
    limits: resolveLimits({ plan: unlimitedLimits() }),
  };
}

export function createUnlimitedPlansService(deps: UnlimitedPlansDeps): PlansService {
  const { db, repo } = deps;
  const scope = { isPlatformAdmin: false };
  const effective = selfHosted();

  /** The catalog is not offered in this edition — a self-hoster has nothing to buy. */
  function notAvailable(): never {
    throw new RelayError('not_found', {
      message: 'Plans are not available in the self-hosted edition; every limit is unlimited.',
    });
  }

  return {
    effectiveFor: () => Promise.resolve(effective),
    effectiveIn: () => Promise.resolve(effective),

    ceilingsIn(): Promise<PlanCeilings> {
      return Promise.resolve({
        planCode: SELF_HOSTED_PLAN_CODE,
        entitlements: flatten(effective.limits),
        rpm: null,
        tpm: null,
        monthlySpendUsd: null,
      });
    },

    // The two assertions the rest of the server calls on every create and every gated capability.
    // Returning immediately is the entire point: no self-hoster is ever limited by code we wrote to
    // sell something.
    assertQuota: () => Promise.resolve(),
    assertFeature: () => Promise.resolve(),
    assertFeatureIn: () => Promise.resolve(),

    usageIn: (tx, orgId, quotaScope) => repo.usage(tx, orgId, quotaScope),
    usageFor: (orgId, quotaScope) =>
      db.withTenant(orgId, scope, (tx) => repo.usage(tx, orgId, quotaScope)),

    listCatalog: () => Promise.resolve([]),
    getSubscription: () => Promise.resolve(null),
    setSubscription: () => notAvailable(),
    changePlan: () => notAvailable(),
  };
}
