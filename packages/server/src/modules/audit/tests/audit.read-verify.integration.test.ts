/**
 * Audit read/verify integration (Week 3 Day 12) — the read + verify surface against a REAL Postgres.
 * Appends a chain, lists it back through the service, verifies it holds, then tampers a stored row and
 * proves verify catches the break at the right seq. Self-skips unless a superuser URL is set (it seeds
 * an org, which bypasses RLS). Cross-tenant RLS for audit_log is proven by the G4 suite.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initDb, resetDb, type Database } from '../../../platform/db.js';
import { createAuditRepository } from '../repositories/audit.repository.js';
import { createAuditService } from '../services/audit.service.js';

const url = process.env.RELAY_MIGRATION_DATABASE_URL ?? process.env.RELAY_TEST_DATABASE_URL;

describe.skipIf(!url)('audit read/verify (integration)', () => {
  let db: Database;
  let orgId: string;

  beforeAll(async () => {
    resetDb();
    db = initDb(url!);
    const rows = await db.run<{ id: string }>({
      text: `INSERT INTO organizations (logto_org_id, name) VALUES ($1, 'Audit RV IT') RETURNING id`,
      values: [`audit-rv-${randomUUID()}`],
    });
    orgId = rows[0]!.id;
    const repo = createAuditRepository();
    await db.withTenant(orgId, { isPlatformAdmin: true }, async (tx) => {
      await repo.appendWithTx(tx, orgId, { actor: 'system', action: 'org.create', target: orgId });
      await repo.appendWithTx(tx, orgId, {
        actor: 'u1',
        action: 'key.issue',
        data: { env: 'live' },
      });
      await repo.appendWithTx(tx, orgId, { actor: 'u1', action: 'org.suspend' });
    });
  });

  afterAll(async () => {
    if (orgId) await db.run({ text: `DELETE FROM organizations WHERE id = $1`, values: [orgId] });
    await db.close();
    resetDb();
  });

  it('lists the trail newest-first with hex hashes', async () => {
    const svc = createAuditService({ db, repo: createAuditRepository() });
    const records = await svc.list(orgId, { limit: 50 });
    expect(records.map((r) => r.seq)).toEqual([3, 2, 1]);
    expect(records[0]?.action).toBe('org.suspend');
    expect(records[0]?.hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it('respects the before cursor for paging', async () => {
    const svc = createAuditService({ db, repo: createAuditRepository() });
    const page = await svc.list(orgId, { limit: 50, before: 3 });
    expect(page.map((r) => r.seq)).toEqual([2, 1]);
  });

  it('verifies an intact chain', async () => {
    const svc = createAuditService({ db, repo: createAuditRepository() });
    expect(await svc.verify(orgId)).toEqual({ orgId, count: 3, valid: true });
  });

  it('detects a tampered payload at the right seq', async () => {
    // Mutate seq 2's stored payload without recomputing the chain — verify must catch it.
    await db.withTenant(orgId, { isPlatformAdmin: true }, (tx) =>
      tx.run({
        text: `UPDATE audit_log SET canonical_json = '{"seq":2,"action":"HACKED"}'::jsonb
                WHERE org_id = $1 AND seq = 2`,
        values: [orgId],
      }),
    );
    const svc = createAuditService({ db, repo: createAuditRepository() });
    const result = await svc.verify(orgId);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(2);
  });
});
