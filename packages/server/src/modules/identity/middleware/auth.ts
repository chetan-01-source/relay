/**
 * Auth preHandlers — the identity module's PUBLIC SURFACE (DEVELOPMENT.md §2 cross-cutting note).
 * These are HTTP-boundary concerns that run BEFORE controllers; app.ts attaches them per route group.
 * Each resolves the tenant and binds the ALS context, so every log line, withTenant call, and metric
 * downstream carries org_id/trace_id without threading them by hand.
 *
 * Status contract (ADR two-auth-planes): 401 = missing/bad credential; 403 = valid but insufficient
 * (revoked key is 401 — the credential itself is no longer valid; suspended org is 403 — the
 * credential is fine but the tenant is blocked; missing scope is 403).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from '@relay/shared';
import { enterContext } from '../../../platform/als.js';
import type { JwtVerifier } from '../services/jwt.js';
import type { JwtClaims, VirtualKeyResolver, VirtualKeySnapshot } from '../types/identity.types.js';

/** An async Fastify preHandler — assignable to a route's `preHandler` option. */
export type AuthPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

// Attach the resolved identity to the request so controllers read it without re-resolving.
declare module 'fastify' {
  interface FastifyRequest {
    identity?: VirtualKeySnapshot; // data plane (/v1/*)
    claims?: JwtClaims; // control plane (/api/*)
  }
}

const BEARER_RE = /^Bearer\s+(.+)$/i;

function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = BEARER_RE.exec(authorization);
  return match ? match[1]!.trim() : null;
}

/** Data plane: resolve a virtual key to a tenant snapshot, or reject (401/403). */
export function createAuthVirtualKey(resolver: VirtualKeyResolver): AuthPreHandler {
  return async function authVirtualKey(request: FastifyRequest) {
    const traceId = randomUUID();
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      throw new RelayError('invalid_api_key', { message: 'Missing or malformed virtual key.' });
    }

    const snapshot = await resolver.resolve(token);
    if (!snapshot) {
      throw new RelayError('invalid_api_key', { message: 'Invalid virtual key.' });
    }
    if (snapshot.keyStatus === 'revoked') {
      throw new RelayError('key_revoked', { message: 'This virtual key has been revoked.' });
    }
    if (snapshot.orgStatus === 'suspended') {
      throw new RelayError('org_suspended', { message: 'This organization is suspended.' });
    }

    request.identity = snapshot;
    enterContext({ orgId: snapshot.orgId, traceId, isPlatformAdmin: false });
  };
}

/** Control plane: verify a Logto JWT to claims, or reject (401). Null verifier ⇒ not configured. */
export function createAuthJwt(verifier: JwtVerifier | null): AuthPreHandler {
  return async function authJwt(request: FastifyRequest) {
    const traceId = randomUUID();
    if (!verifier) {
      throw new RelayError('invalid_api_key', {
        message: 'Control-plane authentication is not configured.',
      });
    }
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      throw new RelayError('invalid_api_key', { message: 'Missing bearer token.' });
    }

    let claims: JwtClaims;
    try {
      claims = await verifier.verify(token);
    } catch {
      throw new RelayError('invalid_api_key', { message: 'Invalid or expired token.' });
    }

    request.claims = claims;
    enterContext({ orgId: claims.orgId, traceId, isPlatformAdmin: claims.isPlatformAdmin });
  };
}

/**
 * Control-plane scope gate. Must run AFTER authJwt (it reads request.claims). Platform admins
 * bypass. A valid token lacking a required scope is 403 — authenticated but not authorized.
 */
export function requireScope(...required: string[]): AuthPreHandler {
  // Not async: it only inspects already-resolved claims and throws — Fastify handles a synchronous
  // throw in a preHandler the same as a rejected promise. Returns a resolved promise on success.
  return function requireScopeHandler(request: FastifyRequest) {
    const claims = request.claims;
    if (!claims) {
      throw new RelayError('invalid_api_key', { message: 'Authentication required.' });
    }
    if (!claims.isPlatformAdmin) {
      const missing = required.filter((scope) => !claims.scopes.includes(scope));
      if (missing.length > 0) {
        throw new RelayError('insufficient_scope', {
          message: `Missing required scope(s): ${missing.join(', ')}.`,
        });
      }
    }
    return Promise.resolve();
  };
}
