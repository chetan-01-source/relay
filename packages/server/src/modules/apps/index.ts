/**
 * Apps module public face (dependency-cruiser: only index.ts is cross-importable). Wires the
 * org-scoped app + virtual-key control plane: repository → service → controller → routes, with the
 * audit trail and snapshot-invalidation bus injected. The composition root (src/app.ts) calls
 * registerApps and passes the identity preHandlers used to guard every route.
 *
 * Layering (DEVELOPMENT.md §2): routes → controller → service → repository → queries.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../platform/db.js';
import type { EventBus } from '../../platform/eventbus.js';
import { createAuditRepository } from '../audit/index.js';
import type { AuthPreHandler } from '../identity/index.js';
import { createAppsRepository } from './repositories/apps.repository.js';
import { createAppsService } from './services/apps.service.js';
import { createAppsController } from './controllers/apps.controller.js';
import { registerAppsRoutes } from './routes/apps.routes.js';

export interface RegisterAppsOptions {
  db: Database;
  masterKey: string;
  bus?: EventBus; // absent for the offline `relay openapi` dump — invalidation is skipped
  guards: {
    authJwt: AuthPreHandler;
    requireScope: (...scopes: string[]) => AuthPreHandler;
  };
}

export function registerApps(app: FastifyInstance, opts: RegisterAppsOptions): void {
  const service = createAppsService({
    db: opts.db,
    repo: createAppsRepository(),
    audit: createAuditRepository(),
    masterKey: opts.masterKey,
    bus: opts.bus ?? null,
  });
  const controller = createAppsController(service);
  registerAppsRoutes(app, controller, opts.guards);
}
