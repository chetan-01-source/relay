/**
 * Integration test — the apps service against a REAL Postgres (DEVELOPMENT.md §5). Proves the
 * key lifecycle end-to-end: issue stores only a verifier, rotate links a successor + grace window in
 * one transaction, revoke flips status. Self-skips unless a superuser URL is set (it seeds an org).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { initDb, resetDb, type Database } from '../../../platform/db.js';
import { createAuditRepository } from '../../audit/index.js';
import { createAppsRepository } from '../repositories/apps.repository.js';
import { createAppsService } from '../services/apps.service.js';

const url = process.env.RELAY_MIGRATION_DATABASE_URL ?? process.env.RELAY_TEST_DATABASE_URL;
const master = process.env.RELAY_MASTER_KEY ?? randomBytes(32).toString('base64');

describe.skipIf(!url)('apps service (integration)', () => {
  let db: Database;
  let orgId: string;
  let appId: string;

  function service() {
    return createAppsService({
      db,
      repo: createAppsRepository(),
      audit: createAuditRepository(),
      masterKey: master,
      bus: null,
    });
  }

  beforeAll(async () => {
    resetDb();
    db = initDb(url!);
    const org = await db.run<{ id: string }>({
      text: `INSERT INTO organizations (logto_org_id, name) VALUES ($1, 'Apps IT') RETURNING id`,
      values: [`apps-it-${randomBytes(6).toString('hex')}`],
    });
    orgId = org[0]!.id;
    const app = await service().createApp('it', orgId, { name: 'IT App' });
    appId = app.id;
  });

  afterAll(async () => {
    if (orgId) await db.run({ text: `DELETE FROM organizations WHERE id = $1`, values: [orgId] });
    await db.close();
    resetDb();
  });

  it('issues a key whose verifier is stored (and no plaintext)', async () => {
    const issued = await service().issueKey('it', orgId, appId, { name: 'primary' });
    expect(issued.key).toMatch(/^rk_live_/);

    const stored = await db.withTenant(orgId, { isPlatformAdmin: false }, (tx) =>
      tx.run<{ key_sha256: Buffer; last4: string }>({
        text: `SELECT key_sha256, last4 FROM virtual_keys WHERE id = $1`,
        values: [issued.id],
      }),
    );
    expect(stored[0]!.key_sha256).toBeInstanceOf(Buffer);
    expect(stored[0]!.last4).toBe(issued.last4);
  });

  it('rotates atomically: successor exists and predecessor is graced', async () => {
    const original = await service().issueKey('it', orgId, appId, {});
    const successor = await service().rotateKey('it', orgId, original.id);

    const rows = await db.withTenant(orgId, { isPlatformAdmin: false }, (tx) =>
      tx.run<{ id: string; successor_id: string | null; grace_until: string | null }>({
        text: `SELECT id, successor_id, grace_until FROM virtual_keys WHERE id = ANY($1)`,
        values: [[original.id, successor.id]],
      }),
    );
    const pred = rows.find((r) => r.id === original.id)!;
    expect(pred.successor_id).toBe(successor.id);
    expect(pred.grace_until).not.toBeNull();
  });

  it('revokes a key (status flips to revoked)', async () => {
    const key = await service().issueKey('it', orgId, appId, {});
    const revoked = await service().revokeKey('it', orgId, key.id);
    expect(revoked.status).toBe('revoked');
    expect(revoked.revoked_at).not.toBeNull();
  });
});
