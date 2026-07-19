/**
 * Integration test — the virtual-key resolver against a REAL Postgres (DEVELOPMENT.md §5). Seeds a
 * throwaway org/app/key, then proves resolve() returns the snapshot, verifies the secret, and
 * surfaces status. Self-skips unless a superuser URL is set (seeding orgs bypasses RLS).
 *
 * Run locally:
 *   make up
 *   RELAY_MIGRATION_DATABASE_URL="postgres://postgres:<pw>@localhost:5432/relay" \
 *     pnpm --filter @relay/server test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { initDb, resetDb, type Database } from '../../../platform/db.js';
import { mintVirtualKey } from '../../../platform/crypto.js';
import { createLruCache } from '../lib/snapshot-cache.js';
import { createIdentityRepository } from '../repositories/identity.repository.js';
import { createVirtualKeyResolver } from '../services/resolver.js';
import type { VirtualKeySnapshot } from '../types/identity.types.js';

// Prefer the superuser URL: seeding an organization row bypasses RLS (organizations has no INSERT
// WITH CHECK for non-admins). In CI both URLs point at the postgres superuser.
const url = process.env.RELAY_MIGRATION_DATABASE_URL ?? process.env.RELAY_TEST_DATABASE_URL;
const master = process.env.RELAY_MASTER_KEY ?? randomBytes(32).toString('base64');

describe.skipIf(!url)('identity resolver (integration)', () => {
  let db: Database;
  let orgId: string;
  const logtoOrgId = `it-${randomBytes(6).toString('hex')}`;

  const active = mintVirtualKey(master, 'live');
  const revoked = mintVirtualKey(master, 'live');

  beforeAll(async () => {
    resetDb();
    db = initDb(url!);
    const orgRows = await db.run<{ id: string }>({
      text: `INSERT INTO organizations (logto_org_id, name) VALUES ($1, 'IT Org') RETURNING id`,
      values: [logtoOrgId],
    });
    orgId = orgRows[0]!.id;
    const appRows = await db.run<{ id: string }>({
      text: `INSERT INTO applications (org_id, name) VALUES ($1, 'IT App') RETURNING id`,
      values: [orgId],
    });
    const appId = appRows[0]!.id;
    await db.run({
      text: `INSERT INTO org_features (org_id, feature_key, value) VALUES ($1, 'cache.exact', 'true')`,
      values: [orgId],
    });
    for (const [minted, status] of [
      [active, 'active'],
      [revoked, 'revoked'],
    ] as const) {
      await db.run({
        text: `INSERT INTO virtual_keys (org_id, app_id, key_id, key_sha256, last4, environment, status)
               VALUES ($1, $2, $3, $4, $5, 'live', $6)`,
        values: [orgId, appId, minted.keyId, minted.secretVerifier, minted.last4, status],
      });
    }
  });

  afterAll(async () => {
    if (orgId) {
      await db.run({ text: `DELETE FROM organizations WHERE id = $1`, values: [orgId] });
    }
    await db.close();
    resetDb();
  });

  function newResolver() {
    return createVirtualKeyResolver({
      repo: createIdentityRepository(db),
      cache: createLruCache<VirtualKeySnapshot>(),
      masterKey: master,
    });
  }

  it('resolves an active key to a snapshot with org/app/entitlements', async () => {
    const snap = await newResolver().resolve(active.plaintext);
    expect(snap?.orgId).toBe(orgId);
    expect(snap?.keyStatus).toBe('active');
    expect(snap?.orgStatus).toBe('active');
    expect(snap?.entitlements).toEqual({ 'cache.exact': true });
  });

  it('surfaces a revoked key with its status (caller maps to 401)', async () => {
    const snap = await newResolver().resolve(revoked.plaintext);
    expect(snap?.keyStatus).toBe('revoked');
  });

  it('returns null for a valid selector with the wrong secret', async () => {
    const forged = `rk_live_${active.keyId}.${randomBytes(24).toString('base64url')}`;
    expect(await newResolver().resolve(forged)).toBeNull();
  });

  it('returns null for an unknown selector', async () => {
    const unknown = mintVirtualKey(master, 'live');
    expect(await newResolver().resolve(unknown.plaintext)).toBeNull();
  });
});
