/**
 * Integration test — audit repository against a REAL Postgres (DEVELOPMENT.md §5). Appends a chain
 * and proves seq is contiguous and each hash = sha256(prev_hash || canonical_json). Self-skips
 * unless a superuser URL is set (it seeds an org, which bypasses RLS).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { initDb, resetDb, type Database } from '../../../platform/db.js';
import { createAuditRepository } from '../repositories/audit.repository.js';
import { canonicalize, computeAuditHash } from '../lib/hash-chain.js';

const url = process.env.RELAY_MIGRATION_DATABASE_URL ?? process.env.RELAY_TEST_DATABASE_URL;

describe.skipIf(!url)('audit repository (integration)', () => {
  let db: Database;
  let orgId: string;

  beforeAll(async () => {
    resetDb();
    db = initDb(url!);
    const rows = await db.run<{ id: string }>({
      text: `INSERT INTO organizations (logto_org_id, name) VALUES ($1, 'Audit IT') RETURNING id`,
      values: [`audit-it-${randomBytes(6).toString('hex')}`],
    });
    orgId = rows[0]!.id;
  });

  afterAll(async () => {
    if (orgId) await db.run({ text: `DELETE FROM organizations WHERE id = $1`, values: [orgId] });
    await db.close();
    resetDb();
  });

  it('appends a contiguous, verifiable chain', async () => {
    const repo = createAuditRepository();
    const records = await db.withTenant(orgId, { isPlatformAdmin: true }, async (tx) => [
      await repo.appendWithTx(tx, orgId, { actor: 'system', action: 'org.create', target: orgId }),
      await repo.appendWithTx(tx, orgId, {
        actor: 'u1',
        action: 'org.features.updated',
        data: { k: 1 },
      }),
      await repo.appendWithTx(tx, orgId, { actor: 'u1', action: 'org.suspend' }),
    ]);

    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);

    // Re-read the stored rows and recompute the chain independently.
    const stored = await db.withTenant(orgId, { isPlatformAdmin: true }, (tx) =>
      tx.run<{ seq: string; canonical_json: unknown; prev_hash: Buffer | null; hash: Buffer }>({
        text: `SELECT seq, canonical_json, prev_hash, hash FROM audit_log WHERE org_id = $1 ORDER BY seq`,
        values: [orgId],
      }),
    );

    let prev: Buffer | null = null;
    for (const row of stored) {
      const recomputed = computeAuditHash(prev, canonicalize(row.canonical_json));
      expect(recomputed.equals(row.hash)).toBe(true);
      expect(row.prev_hash === null ? null : row.prev_hash.equals(prev!)).not.toBe(false);
      prev = row.hash;
    }
  });
});
