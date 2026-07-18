/**
 * Models module public face (dependency-cruiser: only index.ts is cross-importable).
 * Wires the full DB-backed stack: repository → service → controller → routes. The DB handle
 * (a Queryable — the singleton in prod) is injected by the composition root (src/app.ts).
 */
import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../../platform/db.js';
import { createModelsRepository } from './repositories/models.repository.js';
import { createModelsService } from './services/models.service.js';
import { createModelsController } from './controllers/models.controller.js';
import { registerModelsRoutes } from './routes/models.routes.js';

export interface RegisterModelsOptions {
  db: Queryable;
}

export function registerModels(app: FastifyInstance, opts: RegisterModelsOptions): void {
  const repository = createModelsRepository(opts.db);
  const service = createModelsService(repository);
  const controller = createModelsController(service);
  registerModelsRoutes(app, controller);
}
