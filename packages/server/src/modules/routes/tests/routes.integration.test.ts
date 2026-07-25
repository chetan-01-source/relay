/**
 * Routes repository integration (Week 3 Day 13) — exercises the real SQL against a real Postgres so
 * the parametrized queries, the route→version→target invariants, and the model_catalog capability
 * join (known_model) are proven end-to-end. Self-skips unless RELAY_TEST_DATABASE_URL is set; a
 * superuser URL is fine (this test seeds an org directly; cross-tenant RLS is proven by the isolation
 * suite). The whole org is deleted on teardown (cascades to routes/versions/targets).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { initDb, resetDb, type Database } from '../../../platform/db.js';
import { createRoutesService } from '../services/routes.service.js';
import { createRoutesRepository } from '../repositories/routes.repository.js';
import type { AuditRepository } from '../../audit/index.js';

const url = process.env.RELAY_TEST_DATABASE_URL;

// A no-op audit stand-in: this test targets the routes SQL, not the (separately tested) hash chain.
const noopAudit: AuditRepository = {
  appendWithTx: (_tx, orgId, e) =>
    Promise.resolve({
      id: 'a',
      orgId,
      seq: 1,
      actor: e.actor,
      action: e.action,
      target: e.target ?? null,
      hash: Buffer.alloc(32),
    }),
};

describe.skipIf(!url)('routes repository (integration)', () => {
  let db: Database;
  let orgId: string;
  let credId: string;

  beforeAll(async () => {
    const seeder = new pg.Client({ connectionString: url });
    await seeder.connect();
    const org = await seeder.query<{ id: string }>(
      `INSERT INTO organizations (logto_org_id, name) VALUES ($1, 'Routes IT') RETURNING id`,
      [`routes-${randomUUID()}`],
    );
    orgId = org.rows[0]!.id;
    // A credential the route target can reference (route_targets.credential_id FK, ON DELETE RESTRICT).
    const cred = await seeder.query<{ id: string }>(
      `INSERT INTO provider_credentials
         (org_id, name, provider, ciphertext, iv, auth_tag, wrapped_dek, last4)
       VALUES ($1, 'it-cred', 'openai', '\\x00', '\\x00', '\\x00', '\\x00', 'wxyz')
       RETURNING id`,
      [orgId],
    );
    credId = cred.rows[0]!.id;
    await seeder.end();
    resetDb();
    db = initDb(url!);
  });

  afterAll(async () => {
    const cleaner = new pg.Client({ connectionString: url });
    await cleaner.connect();
    await cleaner.query(`DELETE FROM organizations WHERE id = $1`, [orgId]); // cascades routes/versions/targets
    await cleaner.end();
    await db.close();
    resetDb();
  });

  it('runs the full lifecycle: create → add version → rollback → cache toggle → delete', async () => {
    const svc = createRoutesService({ db, repo: createRoutesRepository(), audit: noopAudit });
    const target = { credential_id: credId, provider: 'openai', model: 'gpt-4o' };

    // create with a target → version 1 active
    const created = await svc.createRoute('it', orgId, {
      model_name: 'it-alias',
      targets: [target],
    });
    expect(created.versions).toHaveLength(1);
    expect(created.active_version_id).toBe(created.versions[0]!.id);
    // gpt-4o is in the seeded model_catalog → capability-lint badge is "known"
    expect(created.versions[0]!.targets[0]!.known_model).toBe(true);

    // add version 2 (does not auto-activate)
    const withV2 = await svc.addVersion('it', orgId, created.id, {
      strategy: 'weighted',
      targets: [{ ...target, model: 'made-up-model' }],
    });
    expect(withV2.versions).toHaveLength(2);
    expect(withV2.active_version_id).toBe(created.versions[0]!.id);
    const v2 = withV2.versions.find((v) => v.version === 2)!;
    expect(v2.targets[0]!.known_model).toBe(false); // unknown (provider, model) → lint flags it

    // rollback = activate v2
    const rolled = await svc.activateVersion('it', orgId, created.id, v2.id);
    expect(rolled.active_version_id).toBe(v2.id);

    // per-route cache toggle persists
    const cached = await svc.setCacheEnabled('it', orgId, created.id, true);
    expect(cached.cache_enabled).toBe(true);

    // list summary reflects the active version's ordinal + target count. (Under a superuser test URL
    // RLS is bypassed, so the list may include other orgs' routes — find ours by id.)
    const summary = (await svc.listRoutes(orgId)).find((r) => r.id === created.id)!;
    expect(summary.model_name).toBe('it-alias');
    expect(summary.active_version).toBe(2);
    expect(summary.version_count).toBe(2);

    await svc.deleteRoute('it', orgId, created.id);
    expect(await svc.getRoute(orgId, created.id)).toBeNull();
  });
});
