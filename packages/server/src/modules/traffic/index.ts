/**
 * Traffic module public face (dependency-cruiser: only index.ts is cross-importable). Wires the
 * request-feed read surface: repository → service → controller → routes. No new tables — it reads
 * usage_events (0007) and rides the Valkey channel the metering path publishes to for the live feed.
 * The composition root (src/app.ts) calls registerTraffic and passes the identity preHandlers.
 *
 * Layering (DEVELOPMENT.md §2): routes → controller → service → repository → queries.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../platform/db.js';
import type { EventBus } from '../../platform/eventbus.js';
import type { AuthPreHandler } from '../identity/index.js';
import { createTrafficRepository } from './repositories/traffic.repository.js';
import { createTrafficService } from './services/traffic.service.js';
import { createTrafficController } from './controllers/traffic.controller.js';
import { registerTrafficRoutes } from './routes/traffic.routes.js';

export interface RegisterTrafficOptions {
  db: Database;
  bus?: EventBus; // absent for the offline spec dump → the live SSE feed is a no-op
  guards: {
    authJwt: AuthPreHandler;
    requireScope: (...scopes: string[]) => AuthPreHandler;
  };
}

export function registerTraffic(app: FastifyInstance, opts: RegisterTrafficOptions): void {
  const service = createTrafficService({
    db: opts.db,
    repo: createTrafficRepository(),
    ...(opts.bus ? { client: opts.bus.client } : {}),
  });
  const controller = createTrafficController(service);
  registerTrafficRoutes(app, controller, opts.guards);
}
