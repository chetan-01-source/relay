/**
 * Analytics module public face (dependency-cruiser: only index.ts is cross-importable). Wires the
 * full DB-backed stack: repository → service → controller → routes, guarded by the identity JWT
 * preHandlers the composition root injects. Reads the `usage_rollups_hourly` read model only.
 *
 * Layering: routes → controller → service → repository → queries.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../platform/db.js';
import type { AuthPreHandler } from '../identity/index.js';
import { createAnalyticsRepository } from './repositories/analytics.repository.js';
import { createAnalyticsService } from './services/analytics.service.js';
import { createAnalyticsController } from './controllers/analytics.controller.js';
import { registerAnalyticsRoutes } from './routes/analytics.routes.js';

export interface RegisterAnalyticsOptions {
  db: Database;
  guards: {
    authJwt: AuthPreHandler;
    requireScope: (...scopes: string[]) => AuthPreHandler;
  };
}

export function registerAnalytics(app: FastifyInstance, opts: RegisterAnalyticsOptions): void {
  const repository = createAnalyticsRepository();
  const service = createAnalyticsService({ db: opts.db, repo: repository });
  const controller = createAnalyticsController(service);
  registerAnalyticsRoutes(app, controller, opts.guards);
}
