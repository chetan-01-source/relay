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
import { createJwtVerifier, remoteJwks, type JwtVerifier } from './services/jwt.js';
import { createLruCache } from './lib/snapshot-cache.js';
import {
  createAuthVirtualKey,
  createAuthJwt,
  requireScope,
  type AuthPreHandler,
} from './middleware/auth.js';
import { createIdentityController } from './controllers/identity.controller.js';
import { registerIdentityRoutes } from './routes/identity.routes.js';
import type { VirtualKeyResolver, VirtualKeySnapshot } from './types/identity.types.js';

export type { VirtualKeySnapshot, JwtClaims } from './types/identity.types.js';

export interface LogtoJwtConfig {
  endpoint: string; // Logto endpoint; issuer is `${endpoint}/oidc`, JWKS `${endpoint}/oidc/jwks`
  audience: string; // Relay API resource indicator
}

export interface RegisterIdentityOptions {
  db: Database;
  bus?: EventBus; // absent for the offline `relay openapi` dump — invalidation subscriptions skipped
  masterKey: string;
  logto?: LogtoJwtConfig; // when absent the control plane rejects every JWT (401)
}

/** The auth spine app.ts attaches per route group. */
export interface IdentityHandlers {
  authVirtualKey: AuthPreHandler;
  authJwt: AuthPreHandler;
  requireScope: (...scopes: string[]) => AuthPreHandler;
  resolver: VirtualKeyResolver;
}

export async function registerIdentity(
  app: FastifyInstance,
  opts: RegisterIdentityOptions,
): Promise<IdentityHandlers> {
  const repository = createIdentityRepository(opts.db);
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

  const authJwt = createAuthJwt(verifier);
  const controller = createIdentityController();
  registerIdentityRoutes(app, controller, { authJwt, requireScope });

  return {
    authVirtualKey: createAuthVirtualKey(resolver),
    authJwt,
    requireScope,
    resolver,
  };
}
