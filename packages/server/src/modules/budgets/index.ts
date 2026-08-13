/**
 * Budgets module public face (dependency-cruiser: only index.ts is cross-importable). Wires the
 * org-scoped spend ceiling the policy module enforces: repository → service → controller → routes,
 * with the audit trail injected and the event bus wired for snapshot invalidation.
 *
 * Layering (DEVELOPMENT.md §2): routes → controller → service → repository → queries.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../platform/db.js';
import type { EventBus } from '../../platform/eventbus.js';
import { createAuditRepository } from '../audit/index.js';
import type { AuthPreHandler } from '../identity/index.js';
import type { NotificationEnqueuer } from '../notifications/index.js';
import { createBudgetsRepository } from './repositories/budgets.repository.js';
import { createBudgetsService } from './services/budgets.service.js';
import { createBudgetsController } from './controllers/budgets.controller.js';
import { registerBudgetsRoutes } from './routes/budgets.routes.js';

export { BUDGET_PERIODS } from './types/budgets.types.js';
export type { Budget, BudgetPeriod } from './types/budgets.types.js';

export interface RegisterBudgetsOptions {
  db: Database;
  bus?: EventBus; // absent for the offline `relay openapi` dump — invalidation is then a no-op
  /** Produces budget.updated so operators learn a ceiling moved. Absent ⇒ no notifications. */
  notify?: NotificationEnqueuer;
  guards: {
    authJwt: AuthPreHandler;
    requireScope: (...scopes: string[]) => AuthPreHandler;
    requireOrgAdmin: () => AuthPreHandler;
  };
}

export function registerBudgets(app: FastifyInstance, opts: RegisterBudgetsOptions): void {
  const service = createBudgetsService({
    db: opts.db,
    repo: createBudgetsRepository(),
    audit: createAuditRepository(),
    ...(opts.bus ? { bus: opts.bus } : {}),
    ...(opts.notify ? { notify: opts.notify } : {}),
  });
  const controller = createBudgetsController(service);
  registerBudgetsRoutes(app, controller, opts.guards);
}
