/**
 * Isolation suite (G4 · DEVELOPMENT.md §5.3) — the dynamic half of the security spine. Proves that
 * Postgres Row-Level Security blocks every cross-tenant read: org A, scoped through withTenant as the
 * non-superuser relay_app role, can see NONE of org B's rows in ANY tenant table. Zero tolerance.
 *
 * This is the Day-7 scaffold: a matrix of {tenant table} × {org A reading org B's data} that fills
 * out as later days add roles and endpoints. It self-skips unless a REAL relay_app (RLS-applies) URL
 * is supplied — a superuser connection bypasses RLS and would make the probe meaningless:
 *
 *   RELAY_ISOLATION_APP_URL   = postgres://relay_app:<pw>@localhost:5432/relay   (RLS applies)
 *   RELAY_MIGRATION_DATABASE_URL = postgres://postgres:<pw>@localhost:5432/relay (superuser, seeds)
 *
 * The static half (`scripts/check-rls.sh`) guarantees every tenant table HAS the policies; this
 * proves they actually isolate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { initDb, resetDb, type Database } from '../platform/db.js';
import { mintVirtualKey } from '../platform/crypto.js';

const appUrl = process.env.RELAY_ISOLATION_APP_URL; // relay_app (RLS applies) — required to run
const adminUrl = process.env.RELAY_MIGRATION_DATABASE_URL; // superuser — seeds the two orgs
const master = process.env.RELAY_MASTER_KEY ?? randomBytes(32).toString('base64');

// Every tenant table that carries org_id. A cross-tenant read of any of these must return nothing.
const TENANT_TABLES = [
  'applications',
  'virtual_keys',
  'provider_credentials',
  'org_features',
  'audit_log',
  'routes',
  'route_versions',
  'route_targets',
  'budgets',
  'rate_limits',
  'usage_events',
  'usage_rollups_hourly',
] as const;

/** Seed one org (as superuser, bypassing RLS) with a row in every tenant table. Returns its id. */
async function seedOrg(client: pg.Client, label: string): Promise<string> {
  const org = await client.query<{ id: string }>(
    `INSERT INTO organizations (logto_org_id, name) VALUES ($1, $2) RETURNING id`,
    [`iso-${label}-${randomBytes(6).toString('hex')}`, `Iso ${label}`],
  );
  const orgId = org.rows[0]!.id;
  const app = await client.query<{ id: string }>(
    `INSERT INTO applications (org_id, name) VALUES ($1, 'iso-app') RETURNING id`,
    [orgId],
  );
  const minted = mintVirtualKey(master, 'live');
  await client.query(
    `INSERT INTO virtual_keys (org_id, app_id, key_id, key_sha256, last4, environment)
     VALUES ($1, $2, $3, $4, $5, 'live')`,
    [orgId, app.rows[0]!.id, minted.keyId, minted.secretVerifier, minted.last4],
  );
  const cred = await client.query<{ id: string }>(
    `INSERT INTO provider_credentials
       (org_id, name, provider, ciphertext, iv, auth_tag, wrapped_dek, last4)
     VALUES ($1, 'iso-cred', 'openai', $2, $3, $4, $5, 'wxyz') RETURNING id`,
    [orgId, randomBytes(16), randomBytes(12), randomBytes(16), randomBytes(60)],
  );
  await client.query(
    `INSERT INTO org_features (org_id, feature_key, value) VALUES ($1, 'cache.exact', 'true')`,
    [orgId],
  );
  await client.query(
    `INSERT INTO audit_log (org_id, seq, actor, action, canonical_json, hash)
     VALUES ($1, 1, 'system', 'org.create', '{}'::jsonb, $2)`,
    [orgId, randomBytes(32)],
  );

  // Day 9 routing chain: route → version → target (target references the credential above).
  const route = await client.query<{ id: string }>(
    `INSERT INTO routes (org_id, model_name) VALUES ($1, 'gpt-4o') RETURNING id`,
    [orgId],
  );
  const routeId = route.rows[0]!.id;
  const version = await client.query<{ id: string }>(
    `INSERT INTO route_versions (org_id, route_id, version, strategy)
     VALUES ($1, $2, 1, 'priority') RETURNING id`,
    [orgId, routeId],
  );
  await client.query(`UPDATE routes SET active_version_id = $1 WHERE id = $2`, [
    version.rows[0]!.id,
    routeId,
  ]);
  await client.query(
    `INSERT INTO route_targets (org_id, route_version_id, credential_id, provider, model)
     VALUES ($1, $2, $3, 'openai', 'gpt-4o')`,
    [orgId, version.rows[0]!.id, cred.rows[0]!.id],
  );

  // Day 10 policy config rows.
  await client.query(
    `INSERT INTO budgets (org_id, period, limit_usd, hard_cutoff) VALUES ($1, 'monthly', 25, true)`,
    [orgId],
  );
  await client.query(
    `INSERT INTO rate_limits (org_id, scope, rpm, tpm) VALUES ($1, 'org', 60, 1000)`,
    [orgId],
  );

  // Day 11 metering rows: one raw usage event + one hourly rollup.
  await client.query(
    `INSERT INTO usage_events (org_id, app_id, request_id, provider, model, status)
     VALUES ($1, $2, 'iso-trace', 'openai', 'gpt-4o', 'ok')`,
    [orgId, app.rows[0]!.id],
  );
  await client.query(
    `INSERT INTO usage_rollups_hourly (org_id, hour, app_id, provider, model, requests)
     VALUES ($1, date_trunc('hour', now()), $2, 'openai', 'gpt-4o', 1)`,
    [orgId, app.rows[0]!.id],
  );
  return orgId;
}

describe.skipIf(!appUrl || !adminUrl)('cross-tenant isolation (G4)', () => {
  let db: Database; // connected as relay_app — RLS applies to every query
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    const seeder = new pg.Client({ connectionString: adminUrl });
    await seeder.connect();
    orgA = await seedOrg(seeder, 'A');
    orgB = await seedOrg(seeder, 'B');
    await seeder.end();

    resetDb();
    db = initDb(appUrl!);
  });

  afterAll(async () => {
    const cleaner = new pg.Client({ connectionString: adminUrl });
    await cleaner.connect();
    for (const id of [orgA, orgB]) {
      if (id) await cleaner.query(`DELETE FROM organizations WHERE id = $1`, [id]);
    }
    await cleaner.end();
    await db.close();
    resetDb();
  });

  // Positive control: within its own tenant scope, org A sees its own rows.
  it('org A sees its OWN rows in every tenant table', async () => {
    for (const table of TENANT_TABLES) {
      const rows = await db.withTenant(orgA, { isPlatformAdmin: false }, (tx) =>
        tx.run<{ n: string }>({ text: `SELECT count(*) AS n FROM ${table}`, values: [] }),
      );
      expect(Number(rows[0]!.n), `own ${table}`).toBeGreaterThanOrEqual(1);
    }
  });

  // The core probe: scoped to org A, NONE of org B's rows are visible — not by direct filter, not
  // in an unfiltered scan. This is the zero-tolerance gate.
  it('org A can read NONE of org B rows in any tenant table', async () => {
    for (const table of TENANT_TABLES) {
      const targeted = await db.withTenant(orgA, { isPlatformAdmin: false }, (tx) =>
        tx.run<{ n: string }>({
          text: `SELECT count(*) AS n FROM ${table} WHERE org_id = $1`,
          values: [orgB],
        }),
      );
      expect(Number(targeted[0]!.n), `A→B targeted ${table}`).toBe(0);

      const scan = await db.withTenant(orgA, { isPlatformAdmin: false }, (tx) =>
        tx.run<{ org_id: string }>({ text: `SELECT org_id FROM ${table}`, values: [] }),
      );
      expect(
        scan.every((r) => r.org_id === orgA),
        `A scan leaks ${table}`,
      ).toBe(true);
    }
  });

  // A platform admin is the intentional exception — it may read across orgs (still audited).
  it('a platform admin can read across orgs (the controlled bypass)', async () => {
    const rows = await db.withTenant(orgA, { isPlatformAdmin: true }, (tx) =>
      tx.run<{ n: string }>({
        text: `SELECT count(*) AS n FROM applications WHERE org_id = $1`,
        values: [orgB],
      }),
    );
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });
});
