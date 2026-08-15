/**
 * Providers module public face (dependency-cruiser: only index.ts is cross-importable). Wires the
 * org-scoped credential store: repository → service → controller → routes, with the audit trail
 * injected. Also re-exports the pure health-scoring helpers the Day-9 router will consume.
 *
 * Layering (DEVELOPMENT.md §2): routes → controller → service → repository → queries, plus lib/.
 */
import type { BaseUrlPolicy } from './lib/base-url.js';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../platform/db.js';
import { createAuditRepository } from '../audit/index.js';
import type { AuthPreHandler } from '../identity/index.js';
import type { NotificationEnqueuer } from '../notifications/index.js';
import type { PlansService } from '../plans/index.js';
import { createProvidersRepository } from './repositories/providers.repository.js';
import { createProvidersService } from './services/providers.service.js';
import { createProvidersController } from './controllers/providers.controller.js';
import { registerProvidersRoutes } from './routes/providers.routes.js';

export { computeHealthScore, percentile } from './lib/health.js';
export type { HealthSample, HealthScore } from './lib/health.js';

export interface RegisterProvidersOptions {
  db: Database;
  /** Produces provider.deleted. Absent ⇒ no notifications. */
  notify?: NotificationEnqueuer;
  masterKey: string;
  /** Whether a private/loopback upstream address is acceptable on this deployment. */
  baseUrlPolicy: BaseUrlPolicy;
  /** Enforces `providers.max`. Absent ⇒ no quota is applied. */
  plans?: PlansService;
  guards: {
    authJwt: AuthPreHandler;
    requireScope: (...scopes: string[]) => AuthPreHandler;
    requireOrgAdmin: () => AuthPreHandler;
  };
}

export function registerProviders(app: FastifyInstance, opts: RegisterProvidersOptions): void {
  const service = createProvidersService({
    db: opts.db,
    repo: createProvidersRepository(),
    audit: createAuditRepository(),
    ...(opts.notify ? { notify: opts.notify } : {}),
    ...(opts.plans ? { plans: opts.plans } : {}),
    masterKey: opts.masterKey,
    baseUrlPolicy: opts.baseUrlPolicy,
  });
  const controller = createProvidersController(service);
  registerProvidersRoutes(app, controller, opts.guards);
}
