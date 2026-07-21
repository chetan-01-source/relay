import { describe, it, expect } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isRelayError } from '@relay/shared';
import { createAuthVirtualKey, createAuthJwt, requireScope } from '../middleware/auth.js';
import type { JwtVerifier } from '../services/jwt.js';
import type { JwtClaims, VirtualKeyResolver, VirtualKeySnapshot } from '../types/identity.types.js';

const reply = {} as FastifyReply;

function req(authorization?: string): FastifyRequest {
  return { headers: authorization ? { authorization } : {} } as FastifyRequest;
}

function snapshot(over: Partial<VirtualKeySnapshot> = {}): VirtualKeySnapshot {
  return {
    virtualKeyId: 'vk-1',
    keyId: 'kid-1',
    orgId: 'org-1',
    appId: 'app-1',
    environment: 'live',
    orgStatus: 'active',
    keyStatus: 'active',
    graceUntil: null,
    entitlements: {},
    policy: { rateLimit: null, budget: null },
    ...over,
  };
}

/** Resolve a thrown RelayError's code, failing loudly if the call did not throw one. */
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (isRelayError(err)) return err.code;
    throw err;
  }
  throw new Error('expected a RelayError to be thrown');
}

function stubResolver(result: VirtualKeySnapshot | null): VirtualKeyResolver {
  return {
    resolve: () => Promise.resolve(result),
    invalidate: () => {},
    start: () => Promise.resolve(),
  };
}

describe('authVirtualKey preHandler', () => {
  it('401 when the Authorization header is missing or malformed', async () => {
    const auth = createAuthVirtualKey(stubResolver(snapshot()));
    expect(await codeOf(() => auth(req(), reply))).toBe('invalid_api_key');
    expect(await codeOf(() => auth(req('Basic abc'), reply))).toBe('invalid_api_key');
  });

  it('401 when the key does not resolve', async () => {
    const auth = createAuthVirtualKey(stubResolver(null));
    expect(await codeOf(() => auth(req('Bearer rk_live_a.b'), reply))).toBe('invalid_api_key');
  });

  it('401 key_revoked for a revoked key; 403 org_suspended for a suspended org', async () => {
    const revoked = createAuthVirtualKey(stubResolver(snapshot({ keyStatus: 'revoked' })));
    expect(await codeOf(() => revoked(req('Bearer rk_live_a.b'), reply))).toBe('key_revoked');

    const suspended = createAuthVirtualKey(stubResolver(snapshot({ orgStatus: 'suspended' })));
    expect(await codeOf(() => suspended(req('Bearer rk_live_a.b'), reply))).toBe('org_suspended');
  });

  it('binds the resolved identity to the request on success', async () => {
    const auth = createAuthVirtualKey(stubResolver(snapshot()));
    const request = req('Bearer rk_live_a.b');
    await auth(request, reply);
    expect(request.identity?.orgId).toBe('org-1');
    expect(request.identity?.appId).toBe('app-1');
  });
});

const claims: JwtClaims = {
  userId: 'user-1',
  orgId: 'org-1',
  scopes: ['relay:read'],
  isPlatformAdmin: false,
};

function stubVerifier(result: JwtClaims | Error): JwtVerifier {
  return {
    verify: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
  };
}

describe('authJwt preHandler', () => {
  it('401 when the control plane is not configured (null verifier)', async () => {
    const auth = createAuthJwt(null);
    expect(await codeOf(() => auth(req('Bearer x'), reply))).toBe('invalid_api_key');
  });

  it('401 when the token is missing or fails verification', async () => {
    const auth = createAuthJwt(stubVerifier(new Error('bad')));
    expect(await codeOf(() => auth(req(), reply))).toBe('invalid_api_key');
    expect(await codeOf(() => auth(req('Bearer bad'), reply))).toBe('invalid_api_key');
  });

  it('binds the verified claims to the request on success', async () => {
    const auth = createAuthJwt(stubVerifier({ ...claims, isPlatformAdmin: true }));
    const request = req('Bearer good');
    await auth(request, reply);
    expect(request.claims?.userId).toBe('user-1');
    expect(request.claims?.isPlatformAdmin).toBe(true);
  });
});

describe('requireScope preHandler', () => {
  it('401 when authJwt has not run (no claims)', async () => {
    expect(await codeOf(() => requireScope('relay:read')(req(), reply))).toBe('invalid_api_key');
  });

  it('403 when a required scope is missing', async () => {
    const request = req();
    request.claims = { ...claims, scopes: ['relay:read'] };
    expect(await codeOf(() => requireScope('relay:write')(request, reply))).toBe(
      'insufficient_scope',
    );
  });

  it('passes when the scope is present', async () => {
    const request = req();
    request.claims = { ...claims, scopes: ['relay:read', 'relay:write'] };
    await expect(requireScope('relay:write')(request, reply)).resolves.toBeUndefined();
  });

  it('platform admins bypass the scope check', async () => {
    const request = req();
    request.claims = { ...claims, scopes: [], isPlatformAdmin: true };
    await expect(requireScope('relay:write')(request, reply)).resolves.toBeUndefined();
  });
});
