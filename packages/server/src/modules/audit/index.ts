/**
 * Audit module public face (dependency-cruiser: only index.ts is cross-importable). The trail is both
 * a library (other modules append records atomically with the change they record) AND, since Day 12,
 * a read/verify surface: GET /api/v1/audit (org-scoped list) plus the `relay audit verify` operator
 * CLI that re-walks each org's hash chain.
 *
 * Layering: routes → controller → service → repository → queries, plus lib/ (the pure hash chain).
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../platform/db.js';
import type { AuthPreHandler } from '../identity/index.js';
import { createAuditRepository } from './repositories/audit.repository.js';
import { createAuditService } from './services/audit.service.js';
import { createAuditController } from './controllers/audit.controller.js';
import { registerAuditRoutes } from './routes/audit.routes.js';

export { createAuditRepository } from './repositories/audit.repository.js';
export { createAuditService } from './services/audit.service.js';
export { canonicalize, computeAuditHash, verifyChain } from './lib/hash-chain.js';
export type { AuditChainEntry, ChainVerification } from './lib/hash-chain.js';
export type {
  AuditRepository,
  AuditService,
  AuditEventInput,
  AuditRecord,
  AuditVerifyResult,
} from './types/audit.types.js';

export interface RegisterAuditOptions {
  db: Database;
  guards: {
    authJwt: AuthPreHandler;
    requireScope: (...scopes: string[]) => AuthPreHandler;
  };
}

export function registerAudit(app: FastifyInstance, opts: RegisterAuditOptions): void {
  const repository = createAuditRepository();
  const service = createAuditService({ db: opts.db, repo: repository });
  const controller = createAuditController(service);
  registerAuditRoutes(app, controller, opts.guards);
}
