/**
 * Tenancy module public face (dependency-cruiser: only index.ts is cross-importable). Wires the
 * platform control plane for the tenant lifecycle: repository → service → controller → routes, with
 * the audit trail and Logto org-sync injected. The composition root (src/app.ts) calls registerTenancy
 * and passes the identity preHandlers used to guard every route.
 *
 * Layering (DEVELOPMENT.md §2): routes → controller → service → repository → queries, plus lib/
 * (entitlement templates + the onboarding state machine).
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../platform/db.js';
import type { EventBus } from '../../platform/eventbus.js';
import type { LogtoOrgSync } from '../../platform/logto.js';
import { createAuditRepository } from '../audit/index.js';
import type { AuthPreHandler } from '../identity/index.js';
import type { NotificationEnqueuer } from '../notifications/index.js';
import type { PlansService } from '../plans/index.js';
import { createTenancyRepository } from './repositories/tenancy.repository.js';
import { createTenancyService } from './services/tenancy.service.js';
import { createTenancyController } from './controllers/tenancy.controller.js';
import { registerTenancyRoutes } from './routes/tenancy.routes.js';

export interface RegisterTenancyOptions {
  db: Database;
  /** Produces org.suspended and member.removed. Absent ⇒ no notifications. */
  notify?: NotificationEnqueuer;
  bus?: EventBus; // absent for the offline `relay openapi` dump — snapshot invalidation is skipped
  logto?: LogtoOrgSync; // absent when Logto M2M is not configured — onboarding returns 503
  /** Base URL of the console; invitation emails link to `${consoleUrl}/invitations/{id}`. */
  consoleUrl?: string | undefined;
  /** Enforces `members.max` when an invitation is issued. Absent ⇒ no seat ceiling. */
  plans?: PlansService;
  guards: {
    authJwt: AuthPreHandler;
    requireScope: (...scopes: string[]) => AuthPreHandler;
  };
}

export function registerTenancy(app: FastifyInstance, opts: RegisterTenancyOptions): void {
  const repository = createTenancyRepository();
  const audit = createAuditRepository();
  const service = createTenancyService({
    db: opts.db,
    repo: repository,
    audit,
    logto: opts.logto ?? null,
    bus: opts.bus ?? null,
    // Both were being dropped here: the service takes a notifier (member.removed never reached a
    // tenant's channel) and now a console URL for the invitation link.
    ...(opts.notify ? { notify: opts.notify } : {}),
    ...(opts.plans ? { plans: opts.plans } : {}),
    consoleUrl: opts.consoleUrl,
  });
  const controller = createTenancyController(service);
  registerTenancyRoutes(app, controller, opts.guards);
}
