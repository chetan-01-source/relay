import { describe, it, expect } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isRelayError } from 'relay-shared';
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
    planCode: null,
    policy: { rateLimit: null, budgets: [] },
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

  // The token carries Logto's org id; RLS binds our uuid. Skipping this translation makes every
  // tenant query fail the `app.current_org::uuid` cast.
  it('translates the Logto org claim to our tenant uuid', async () => {
    const relayUuid = '0744ded6-30b6-4990-a3df-3f2ce74d632c';
    const auth = createAuthJwt(stubVerifier({ ...claims, orgId: 'logto-org' }), {
      resolve: (logtoOrgId) => Promise.resolve(logtoOrgId === 'logto-org' ? relayUuid : null),
      invalidate: () => undefined,
    });
    const request = req('Bearer good');
    await auth(request, reply);
    expect(request.claims?.orgId).toBe(relayUuid);
  });

  it('leaves orgId null when the claim names an org we do not know — not a 401', async () => {
    // The token is genuine; the user just belongs to no Relay tenant. Platform-admin routes must
    // still work, and org-scoped controllers reject it themselves.
    const auth = createAuthJwt(stubVerifier({ ...claims, orgId: 'stranger' }), {
      resolve: () => Promise.resolve(null),
      invalidate: () => undefined,
    });
    const request = req('Bearer good');
    await auth(request, reply);
    expect(request.claims?.orgId).toBeNull();
  });

  it('leaves a null org claim alone without consulting the resolver', async () => {
    let consulted = false;
    const auth = createAuthJwt(stubVerifier({ ...claims, orgId: null }), {
      resolve: () => {
        consulted = true;
        return Promise.resolve(null);
      },
      invalidate: () => undefined,
    });
    const request = req('Bearer good');
    await auth(request, reply);
    expect(request.claims?.orgId).toBeNull();
    expect(consulted).toBe(false);
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
