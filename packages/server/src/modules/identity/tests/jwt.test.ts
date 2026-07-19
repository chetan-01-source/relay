import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import { createJwtVerifier, type JwtVerifier } from '../services/jwt.js';

const ISSUER = 'http://localhost:3001/oidc';
const AUDIENCE = 'https://relay.gateway/api';
const KID = 'test-key';

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let keySet: JWTVerifyGetKey;
let verifier: JwtVerifier;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  keySet = createLocalJWKSet({ keys: [publicJwk] });
  verifier = createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE }, keySet);
});

interface TokenOpts {
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  scope?: string;
  roles?: string[];
  organizationId?: string;
  sub?: string;
}

function sign(opts: TokenOpts = {}): Promise<string> {
  const jwt = new SignJWT({
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts.roles !== undefined ? { roles: opts.roles } : {}),
    ...(opts.organizationId !== undefined ? { organization_id: opts.organizationId } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setSubject(opts.sub ?? 'user-1')
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m');
  return jwt.sign(privateKey);
}

describe('Logto JWT verifier', () => {
  it('verifies a valid token and maps claims', async () => {
    const token = await sign({ scope: 'relay:read relay:write', organizationId: 'org-42' });
    const claims = await verifier.verify(token);
    expect(claims.userId).toBe('user-1');
    expect(claims.orgId).toBe('org-42');
    expect(claims.scopes).toEqual(['relay:read', 'relay:write']);
    expect(claims.isPlatformAdmin).toBe(false);
  });

  it('marks platform admins from the relay_admin role or platform:admin scope', async () => {
    expect((await verifier.verify(await sign({ roles: ['relay_admin'] }))).isPlatformAdmin).toBe(
      true,
    );
    expect((await verifier.verify(await sign({ scope: 'platform:admin' }))).isPlatformAdmin).toBe(
      true,
    );
  });

  it('defaults orgId to null and scopes to [] when absent', async () => {
    const claims = await verifier.verify(await sign());
    expect(claims.orgId).toBeNull();
    expect(claims.scopes).toEqual([]);
  });

  it('rejects an expired token', async () => {
    const token = await sign({ expiresIn: '-1h' }); // already expired, beyond the 60s tolerance
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('rejects a wrong issuer', async () => {
    await expect(verifier.verify(await sign({ issuer: 'http://evil/oidc' }))).rejects.toThrow();
  });

  it('rejects a wrong audience', async () => {
    await expect(verifier.verify(await sign({ audience: 'https://other/api' }))).rejects.toThrow();
  });
});
