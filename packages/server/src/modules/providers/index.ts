/**
 * Providers module public face (dependency-cruiser: only index.ts is cross-importable). Wires the
 * org-scoped credential store: repository → service → controller → routes, with the audit trail
 * injected. Also re-exports the pure health-scoring helpers the Day-9 router will consume.
 *
 * Layering (DEVELOPMENT.md §2): routes → controller → service → repository → queries, plus lib/.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../platform/db.js';
import { createAuditRepository } from '../audit/index.js';
import type { AuthPreHandler } from '../identity/index.js';
import { createProvidersRepository } from './repositories/providers.repository.js';
import { createProvidersService } from './services/providers.service.js';
import { createProvidersController } from './controllers/providers.controller.js';
import { registerProvidersRoutes } from './routes/providers.routes.js';

export { computeHealthScore, percentile } from './lib/health.js';
export type { HealthSample, HealthScore } from './lib/health.js';

export interface RegisterProvidersOptions {
  db: Database;
  masterKey: string;
  guards: {
    authJwt: AuthPreHandler;
    requireScope: (...scopes: string[]) => AuthPreHandler;
  };
}

export function registerProviders(app: FastifyInstance, opts: RegisterProvidersOptions): void {
  const service = createProvidersService({
    db: opts.db,
    repo: createProvidersRepository(),
    audit: createAuditRepository(),
    masterKey: opts.masterKey,
  });
  const controller = createProvidersController(service);
  registerProvidersRoutes(app, controller, opts.guards);
}
