/**
 * Integration test — the providers service against a REAL Postgres (DEVELOPMENT.md §5). Proves a
 * credential is sealed on write (ciphertext persisted, decrypts back) and that reads return metadata
 * only. Self-skips unless a superuser URL is set (it seeds an org).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { initDb, resetDb, type Database } from '../../../platform/db.js';
import { openCredential, type SealedCredential } from '../../../platform/crypto.js';
import { createAuditRepository } from '../../audit/index.js';
import { createProvidersRepository } from '../repositories/providers.repository.js';
import { createProvidersService } from '../services/providers.service.js';

const url = process.env.RELAY_MIGRATION_DATABASE_URL ?? process.env.RELAY_TEST_DATABASE_URL;
const master = process.env.RELAY_MASTER_KEY ?? randomBytes(32).toString('base64');

describe.skipIf(!url)('providers service (integration)', () => {
  let db: Database;
  let orgId: string;

  function service() {
    return createProvidersService({
      db,
      repo: createProvidersRepository(),
      audit: createAuditRepository(),
      masterKey: master,
    });
  }

  beforeAll(async () => {
    resetDb();
    db = initDb(url!);
    const org = await db.run<{ id: string }>({
      text: `INSERT INTO organizations (logto_org_id, name) VALUES ($1, 'Prov IT') RETURNING id`,
      values: [`prov-it-${randomBytes(6).toString('hex')}`],
    });
    orgId = org[0]!.id;
  });

  afterAll(async () => {
    if (orgId) await db.run({ text: `DELETE FROM organizations WHERE id = $1`, values: [orgId] });
    await db.close();
    resetDb();
  });

  it('seals on write; ciphertext persists and decrypts, API returns only metadata', async () => {
    const created = await service().createCredential('it', orgId, {
      name: 'prod',
      provider: 'openai',
      apiKey: 'sk-real-secret-9876',
    });
    expect(created.last4).toBe('9876');
    expect(JSON.stringify(created)).not.toContain('sk-real-secret');

    // read the sealed columns directly and prove they round-trip to the plaintext
    const raw = await db.withTenant(orgId, { isPlatformAdmin: false }, (tx) =>
      tx.run<SealedCredential>({
        text: `SELECT ciphertext, iv, auth_tag AS "authTag", wrapped_dek AS "wrappedDek"
               FROM provider_credentials WHERE id = $1`,
        values: [created.id],
      }),
    );
    expect(openCredential(master, raw[0]!)).toBe('sk-real-secret-9876');

    const listed = await service().listCredentials(orgId);
    expect(listed.some((c) => c.id === created.id)).toBe(true);
  });
});
