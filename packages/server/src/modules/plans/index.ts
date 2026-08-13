/**
 * Plans module public face (dependency-cruiser: only index.ts is cross-importable).
 *
 * This module is the ONLY place that decides whether a quota rejects or a capability is included.
 * Other modules call `plans.assertQuota(tx, orgId, key)` inside the transaction that performs the
 * write, and `plans.assertFeature(orgId, key)` before a gated capability — neither of them branches
 * on the edition, because the composition root already chose which implementation answers.
 *
 * Layering (DEVELOPMENT.md §2): routes → controller → service → repository → queries.
 *
 * NOTE on direction: this module imports `identity` (for the route guards and the invalidation
 * publisher). Identity must therefore NEVER import this one, or the graph becomes circular and
 * `pnpm dep-check` fails. Identity gets what it needs through the `PlanSource` interface declared in
 * its own types and wired by app.ts — see `createPlanSource` below.
 */
import type { FastifyInstance } from 'fastify';
import type { Database, Queryable } from '../../platform/db.js';
import type { EventBus } from '../../platform/eventbus.js';
import { createAuditRepository } from '../audit/index.js';
import type { AuthPreHandler } from '../identity/index.js';
import { createPlansRepository } from './repositories/plans.repository.js';
import { createPlansService } from './services/plans.service.js';
import { createUnlimitedPlansService } from './services/unlimited.service.js';
import { createPlansController } from './controllers/plans.controller.js';
import { registerPlansRoutes } from './routes/plans.routes.js';
import type { PlanCeilings, PlansService } from './types/plans.types.js';

export {
  COUNT_LIMIT_KEYS,
  FEATURE_LIMIT_KEYS,
  LIMIT_KEYS,
  isUnlimited,
  tighter,
} from './lib/limits.js';
export type { CountLimitKey, FeatureLimitKey, LimitKey, LimitValue } from './lib/limits.js';
export type {
  EffectivePlan,
  PlanCeilings,
  PlansService,
  QuotaUsage,
  Subscription,
} from './types/plans.types.js';
export { SELF_HOSTED_PLAN_CODE } from './services/unlimited.service.js';

/** Which entitlement regime this deployment runs under (docs/editions.md). */
export type Edition = 'oss' | 'cloud';

export interface CreatePlansOptions {
  db: Database;
  edition: Edition;
  bus?: EventBus;
}

/**
 * Build the service the whole server asks about limits. THE edition switch — the one place the two
 * editions diverge. Every call site downstream is identical in both.
 */
export function createPlans(opts: CreatePlansOptions): PlansService {
  const repo = createPlansRepository();
  if (opts.edition !== 'cloud') {
    return createUnlimitedPlansService({ db: opts.db, repo });
  }
  return createPlansService({
    db: opts.db,
    repo,
    audit: createAuditRepository(),
    ...(opts.bus ? { bus: opts.bus } : {}),
  });
}

export interface RegisterPlansOptions {
  service: PlansService;
  guards: {
    authJwt: AuthPreHandler;
    requireScope: (...scopes: string[]) => AuthPreHandler;
    requireOrgAdmin: () => AuthPreHandler;
  };
}

export function registerPlans(app: FastifyInstance, opts: RegisterPlansOptions): void {
  registerPlansRoutes(app, createPlansController(opts.service), opts.guards);
}

/**
 * Adapt the service to the narrow interface identity's snapshot builder consumes. Handing identity
 * an object with one method — rather than the whole service — is what keeps the dependency one-way
 * and the coupling honest: identity cannot reach the plan vocabulary, only the resolved ceilings.
 */
export function createPlanSource(service: PlansService): {
  forOrg(tx: Queryable, orgId: string): Promise<PlanCeilings>;
} {
  return { forOrg: (tx, orgId) => service.ceilingsIn(tx, orgId) };
}

/**
 * The same trick for metering's retention sweep: it needs one number per org and nothing else.
 * Returns `null` (keep everything) whenever the plan sets no window — which is every org in the
 * self-hosted edition, so a self-hoster's history is never pruned.
 */
export function createRetentionSource(service: PlansService): {
  trafficDaysFor(orgId: string): Promise<number | null>;
} {
  return {
    async trafficDaysFor(orgId) {
      const effective = await service.effectiveFor(orgId);
      const value = effective.limits['retention.traffic_days']?.value;
      return typeof value === 'number' ? value : null;
    },
  };
}
