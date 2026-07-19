/**
 * Integration test — the tenancy service against a REAL Postgres (DEVELOPMENT.md §5). Logto is faked
 * (an external HTTP dependency), but the DB path is real: it proves the onboarding transaction writes
 * the org + entitlements + a chained audit row, and that suspend/entitlement/onboarding mutations
 * persist. Self-skips unless a superuser URL is set (it creates orgs, which bypasses RLS).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { initDb, resetDb, type Database } from '../../../platform/db.js';
import type { LogtoOrgSync } from '../../../platform/logto.js';
import { createAuditRepository } from '../../audit/index.js';
import { createTenancyRepository } from '../repositories/tenancy.repository.js';
import { createTenancyService } from '../services/tenancy.service.js';
import { ENTITLEMENT_TEMPLATES } from '../lib/entitlements.js';

const url = process.env.RELAY_MIGRATION_DATABASE_URL ?? process.env.RELAY_TEST_DATABASE_URL;

const fakeLogto: LogtoOrgSync = {
  createOrganization: () => Promise.resolve(`logto-it-${randomBytes(6).toString('hex')}`),
  deleteOrganization: () => Promise.resolve(),
  inviteAdmin: () => Promise.resolve('inv-it'),
};

describe.skipIf(!url)('tenancy service (integration)', () => {
  let db: Database;
  const createdOrgIds: string[] = [];

  function service() {
    return createTenancyService({
      db,
      repo: createTenancyRepository(),
      audit: createAuditRepository(),
      logto: fakeLogto,
      bus: null,
    });
  }

  beforeAll(() => {
    resetDb();
    db = initDb(url!);
  });

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await db.run({ text: `DELETE FROM organizations WHERE id = $1`, values: [id] });
    }
    await db.close();
    resetDb();
  });

  it('onboards an org with entitlements + an audit row, then reads it back', async () => {
    const svc = service();
    const org = await svc.onboardOrg('admin-it', { name: `IT ${randomBytes(4).toString('hex')}` });
    createdOrgIds.push(org.id);

    expect(org.status).toBe('active');
    expect(org.onboarding_state).toBe('created');
    expect(await svc.getEntitlements(org.id)).toEqual(ENTITLEMENT_TEMPLATES.default);

    // audit row committed atomically with the org
    const audit = await db.withTenant(org.id, { isPlatformAdmin: true }, (tx) =>
      tx.run<{ action: string }>({
        text: `SELECT action FROM audit_log WHERE org_id = $1 ORDER BY seq`,
        values: [org.id],
      }),
    );
    expect(audit.map((r) => r.action)).toEqual(['org.create']);

    const listed = await svc.listOrgs();
    expect(listed.some((o) => o.id === org.id)).toBe(true);
  });

  it('suspends, updates entitlements, and advances onboarding', async () => {
    const svc = service();
    const org = await svc.onboardOrg('admin-it', { name: `IT ${randomBytes(4).toString('hex')}` });
    createdOrgIds.push(org.id);

    expect((await svc.suspendOrg('admin-it', org.id)).status).toBe('suspended');
    expect((await svc.unsuspendOrg('admin-it', org.id)).status).toBe('active');

    const features = await svc.updateEntitlements('admin-it', org.id, {
      features: { 'modalities.image': true },
    });
    expect(features['modalities.image']).toBe(true);

    const advanced = await svc.advanceOnboarding('admin-it', org.id, 'admin_invited');
    expect(advanced.onboarding_state).toBe('admin_invited');

    // every mutation appended to the chain (create, suspend, unsuspend, features, onboarding)
    const count = await db.withTenant(org.id, { isPlatformAdmin: true }, (tx) =>
      tx.run<{ n: string }>({
        text: `SELECT count(*) AS n FROM audit_log WHERE org_id = $1`,
        values: [org.id],
      }),
    );
    expect(Number(count[0]!.n)).toBe(5);
  });
});
