/**
 * Identity module public face (dependency-cruiser: only index.ts is cross-importable). Unlike a
 * routes-only module, identity's real product is a set of preHandlers — the auth spine both planes
 * attach. registerIdentity constructs the stack (repository → resolver → verifier), registers the
 * control-plane /api routes, starts the Valkey invalidation subscriptions, and RETURNS the
 * preHandlers so the composition root (src/app.ts) can guard the data-plane routes with them.
 *
 * Layering (DEVELOPMENT.md §2): routes → controller → service (resolver/jwt) → repository → queries.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../platform/db.js';
import type { EventBus } from '../../platform/eventbus.js';
import { createIdentityRepository } from './repositories/identity.repository.js';
import { createVirtualKeyResolver } from './services/resolver.js';
import { createOrgResolver } from './services/org-resolver.js';
import { createJwtVerifier, remoteJwks, type JwtVerifier } from './services/jwt.js';
import { createLruCache } from './lib/snapshot-cache.js';
import {
  createAuthVirtualKey,
  createAuthJwt,
  requireScope,
  requireOrgAdmin,
  type AuthPreHandler,
} from './middleware/auth.js';
import { createIdentityController } from './controllers/identity.controller.js';
import { registerIdentityRoutes } from './routes/identity.routes.js';
import type { PlanSource, VirtualKeyResolver, VirtualKeySnapshot } from './types/identity.types.js';

export type {
  VirtualKeySnapshot,
  JwtClaims,
  PlanSource,
  PlanCeilingsInput,
} from './types/identity.types.js';
export type { AuthPreHandler } from './middleware/auth.js';

// The write side of the snapshot-invalidation contract — other modules publish through these so the
// data plane's in-process snapshots stay correct (tenancy suspends orgs, apps revoke keys).
export {
  publishKeyInvalidation,
  publishOrgSuspend,
  publishOrgFeaturesUpdated,
  publishOrgPolicyUpdated,
} from './lib/invalidation.js';

export interface LogtoJwtConfig {
  endpoint: string; // Logto endpoint; issuer is `${endpoint}/oidc`, JWKS `${endpoint}/oidc/jwks`
  audience: string; // Relay API resource indicator
}

export interface RegisterIdentityOptions {
  db: Database;
  bus?: EventBus; // absent for the offline `relay openapi` dump — invalidation subscriptions skipped
  masterKey: string;
  logto?: LogtoJwtConfig; // when absent the control plane rejects every JWT (401)
  /**
   * Supplies the plan-derived layer of each snapshot (ADR-0014). Injected rather than imported: the
   * plans module depends on identity's guards, so identity depending on plans would make the graph
   * circular. Absent ⇒ snapshots are built from the org's own flags and policy alone.
   */
  planSource?: PlanSource;
}

/** The auth spine app.ts attaches per route group. */
export interface IdentityHandlers {
  authVirtualKey: AuthPreHandler;
  authJwt: AuthPreHandler;
  requireScope: (...scopes: string[]) => AuthPreHandler;
  /** Gate for actions only an organization administrator may take (see middleware/auth.ts). */
  requireOrgAdmin: () => AuthPreHandler;
  resolver: VirtualKeyResolver;
}

export async function registerIdentity(
  app: FastifyInstance,
  opts: RegisterIdentityOptions,
): Promise<IdentityHandlers> {
  const repository = createIdentityRepository(opts.db, opts.planSource);
  const cache = createLruCache<VirtualKeySnapshot>();
  const resolver = createVirtualKeyResolver({
    repo: repository,
    cache,
    masterKey: opts.masterKey,
    ...(opts.bus ? { bus: opts.bus } : {}),
  });
  await resolver.start();

  const verifier: JwtVerifier | null = opts.logto
    ? createJwtVerifier(
        { issuer: `${opts.logto.endpoint}/oidc`, audience: opts.logto.audience },
        remoteJwks(`${opts.logto.endpoint}/oidc/jwks`),
      )
    : null;

  // Translates the token's Logto `organization_id` into our organizations.id — the uuid RLS binds
  // to app.current_org. Its own small cache: the mapping is immutable, and orgs are few.
  const orgResolver = createOrgResolver({
    repo: repository,
    cache: createLruCache<string>(1_000),
  });

  const authJwt = createAuthJwt(verifier, orgResolver, repository);
  const controller = createIdentityController();
  registerIdentityRoutes(app, controller, { authJwt, requireScope });

  return {
    authVirtualKey: createAuthVirtualKey(resolver),
    authJwt,
    requireScope,
    requireOrgAdmin,
    resolver,
  };
}
