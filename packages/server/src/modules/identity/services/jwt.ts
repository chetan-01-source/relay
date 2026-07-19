/**
 * Logto JWT verifier (Week 2 Day 6 · ADR two-auth-planes). Verifies a control-plane bearer token
 * against Logto's JWKS (fetched once, cached in-memory by jose), checking signature + issuer +
 * audience + exp/nbf with a ±60s clock tolerance. Maps the payload to the tenant claims the control
 * plane needs. The key set is injected so tests can verify against a locally-generated JWKS.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { JwtClaims } from '../types/identity.types.js';

const CLOCK_TOLERANCE_SECONDS = 60; // PRD: iss/aud/exp/nbf ±60s

export interface JwtVerifierConfig {
  issuer: string; // Logto issuer — `${endpoint}/oidc`
  audience: string; // Relay API resource indicator
}

export interface JwtVerifier {
  verify(token: string): Promise<JwtClaims>;
}

/** Remote JWKS resolver (production). Caches keys and refreshes on rotation. */
export function remoteJwks(jwksUri: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUri));
}

export function createJwtVerifier(cfg: JwtVerifierConfig, keySet: JWTVerifyGetKey): JwtVerifier {
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, keySet, {
        issuer: cfg.issuer,
        audience: cfg.audience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      return toClaims(payload);
    },
  };
}

/**
 * Map a verified payload to claims. Scopes come from the space-delimited `scope` string (OAuth
 * convention). Logto puts the active org on `organization_id`; platform-admin is granted by the
 * relay_admin role or an explicit platform:admin scope.
 */
function toClaims(payload: JWTPayload): JwtClaims {
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
  const orgId = typeof payload.organization_id === 'string' ? payload.organization_id : null;
  const roles = Array.isArray(payload.roles) ? (payload.roles as unknown[]).map(String) : [];
  return {
    userId: payload.sub ?? '',
    orgId,
    scopes,
    isPlatformAdmin: roles.includes('relay_admin') || scopes.includes('platform:admin'),
  };
}
