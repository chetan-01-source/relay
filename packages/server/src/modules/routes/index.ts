/**
 * Routes module public face (dependency-cruiser: only index.ts is cross-importable). Wires the
 * org-scoped routes-editor control plane: repository → service → controller → routes, with the audit
 * trail injected. Reuses the routing tables (0005) + the Day-13 cache_enabled column (0012). The
 * composition root (src/app.ts) calls registerRoutes and passes the identity preHandlers.
 *
 * Layering (DEVELOPMENT.md §2): routes → controller → service → repository → queries.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../platform/db.js';
import { createAuditRepository } from '../audit/index.js';
import type { AuthPreHandler } from '../identity/index.js';
import { createRoutesRepository } from './repositories/routes.repository.js';
import { createRoutesService } from './services/routes.service.js';
import { createRoutesController } from './controllers/routes.controller.js';
import { registerRoutesRoutes } from './routes/routes.routes.js';

export interface RegisterRoutesOptions {
  db: Database;
  guards: {
    authJwt: AuthPreHandler;
    requireScope: (...scopes: string[]) => AuthPreHandler;
  };
}

export function registerRoutes(app: FastifyInstance, opts: RegisterRoutesOptions): void {
  const service = createRoutesService({
    db: opts.db,
    repo: createRoutesRepository(),
    audit: createAuditRepository(),
  });
  const controller = createRoutesController(service);
  registerRoutesRoutes(app, controller, opts.guards);
}
