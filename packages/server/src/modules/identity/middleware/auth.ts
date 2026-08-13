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
import type { OrgResolver } from '../services/org-resolver.js';
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

/**
 * Reads the caller's role within an org. Narrower than the whole IdentityRepository on purpose —
 * this middleware needs one lookup, and depending on the full repository would let it grow into
 * doing more.
 */
export interface OrgRoleReader {
  getOrgMemberRole(orgId: string, userId: string): Promise<'admin' | 'member'>;
}

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
    // A rotated predecessor stays usable only until its grace window closes, then it is dead.
    if (snapshot.graceUntil && Date.now() > Date.parse(snapshot.graceUntil)) {
      throw new RelayError('key_revoked', {
        message: 'This virtual key has expired after rotation.',
      });
    }
    if (snapshot.orgStatus === 'suspended') {
      throw new RelayError('org_suspended', { message: 'This organization is suspended.' });
    }

    request.identity = snapshot;
    enterContext({ orgId: snapshot.orgId, traceId, isPlatformAdmin: false });
  };
}

/**
 * Control plane: verify a Logto JWT to claims, or reject (401). Null verifier ⇒ not configured.
 *
 * The `organization_id` claim is Logto's org id; `orgResolver` translates it to our
 * `organizations.id`, because that uuid — not Logto's — is the tenant key RLS binds to
 * `app.current_org`. Without the translation the first tenant query fails the uuid cast.
 *
 * A claim that resolves to no org of ours degrades to `orgId: null` rather than 401: the token is
 * genuine, the user simply isn't a member of an org Relay knows. Controllers already reject that
 * with "This token is not scoped to an organization", and platform-admin routes still work — which
 * is exactly what an admin who belongs to no tenant needs.
 */
export function createAuthJwt(
  verifier: JwtVerifier | null,
  orgResolver: OrgResolver | null = null,
  roles: OrgRoleReader | null = null,
): AuthPreHandler {
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

    if (claims.orgId && orgResolver) {
      claims = { ...claims, orgId: await orgResolver.resolve(claims.orgId) };
    }

    // Org role, resolved from OUR table rather than the token. Logto decides who is a member; Relay
    // decides what a member may do, so this cannot be a claim the identity provider could set.
    // Skipped when the token names no org of ours: there is no membership to look up. A platform
    // admin is treated as an admin of whichever org they are acting on — they already bypass every
    // scope gate, so pretending otherwise here would only make the console lie about what they can do.
    if (claims.orgId && roles) {
      claims = {
        ...claims,
        isOrgAdmin:
          claims.isPlatformAdmin ||
          (await roles.getOrgMemberRole(claims.orgId, claims.userId)) === 'admin',
      };
    } else {
      claims = { ...claims, isOrgAdmin: claims.isPlatformAdmin };
    }

    request.claims = claims;
    enterContext({ orgId: claims.orgId, traceId, isPlatformAdmin: claims.isPlatformAdmin });
  };
}

/**
 * Org-admin gate. Must run AFTER authJwt, which resolves the role.
 *
 * This sits ALONGSIDE requireScope, not instead of it: a scope says what kind of operation a token
 * may perform, the role says who inside the tenant may perform it. Budgets and provider credentials
 * are the two places where an ordinary member could spend the org's money or swap the key its
 * traffic flows through, so both gates apply — the scope first, then this.
 */
export function requireOrgAdmin(): AuthPreHandler {
  return function requireOrgAdminHandler(request: FastifyRequest) {
    const claims = request.claims;
    if (!claims) {
      throw new RelayError('invalid_api_key', { message: 'Authentication required.' });
    }
    if (!claims.isOrgAdmin) {
      throw new RelayError('insufficient_scope', {
        message: 'This action requires an organization administrator.',
      });
    }
    return Promise.resolve();
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
