/**
 * Demo seed (PRD Day 5) — creates one fully-formed tenant so `make up` yields a working curl:
 * org → app → provider credential (envelope-encrypted) → route → target → a fresh virtual key.
 *
 * Ops script, not a request module — runs as the migration role (superuser, bypasses RLS) and uses
 * inline parametrized SQL (still injection-safe). Idempotent by reset: the demo org's child rows are
 * cleared and re-seeded each run, and a new key is minted and printed (plaintext is never recoverable).
 */
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { sealCredential } from '../platform/crypto.js';

export interface DemoSeedResult {
  apiKey: string;
  curl: string;
}

async function insertReturningId(
  client: pg.Client,
  sql: string,
  values: unknown[],
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(sql, values);
  return rows[0]!.id;
}

export async function seedDemo(
  databaseUrl: string,
  masterKey: string,
  upstreamUrl: string,
): Promise<DemoSeedResult> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');

    const orgId = await insertReturningId(
      client,
      `INSERT INTO organizations (logto_org_id, name) VALUES ($1, $2)
       ON CONFLICT (logto_org_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      ['demo', 'Demo Org'],
    );

    // reset demo children (order respects FKs: routes→targets cascade, then app→keys, then cred)
    await client.query(`DELETE FROM routes WHERE org_id = $1 AND model_name = $2`, [
      orgId,
      'gpt-4o',
    ]);
    await client.query(`DELETE FROM applications WHERE org_id = $1 AND name = $2`, [
      orgId,
      'Demo App',
    ]);
    await client.query(`DELETE FROM provider_credentials WHERE org_id = $1 AND name = $2`, [
      orgId,
      'Demo Provider',
    ]);

    const appId = await insertReturningId(
      client,
      `INSERT INTO applications (org_id, name) VALUES ($1, $2) RETURNING id`,
      [orgId, 'Demo App'],
    );

    const sealed = sealCredential(masterKey, 'sk-demo-mock-key');
    const credId = await insertReturningId(
      client,
      `INSERT INTO provider_credentials
         (org_id, name, provider, ciphertext, iv, auth_tag, wrapped_dek, last4, base_url)
       VALUES ($1, $2, 'openai_compat', $3, $4, $5, $6, 'mock', $7) RETURNING id`,
      [
        orgId,
        'Demo Provider',
        sealed.ciphertext,
        sealed.iv,
        sealed.authTag,
        sealed.wrappedDek,
        upstreamUrl,
      ],
    );

    const routeId = await insertReturningId(
      client,
      `INSERT INTO routes (org_id, model_name) VALUES ($1, 'gpt-4o') RETURNING id`,
      [orgId],
    );
    const versionId = await insertReturningId(
      client,
      `INSERT INTO route_versions (org_id, route_id, version, strategy)
       VALUES ($1, $2, 1, 'priority') RETURNING id`,
      [orgId, routeId],
    );
    await client.query(`UPDATE routes SET active_version_id = $1 WHERE id = $2`, [
      versionId,
      routeId,
    ]);
    await client.query(
      `INSERT INTO route_targets (org_id, route_version_id, credential_id, provider, model, priority, weight)
       VALUES ($1, $2, $3, 'openai_compat', 'gpt-4o', 100, 1)`,
      [orgId, versionId, credId],
    );

    // mint a fresh virtual key — shown once, only its SHA-256 is stored
    const apiKey = `rk_live_${randomBytes(24).toString('base64url')}`;
    const sha256 = createHash('sha256').update(apiKey).digest();
    await client.query(
      `INSERT INTO virtual_keys (org_id, app_id, key_sha256, last4, name, environment)
       VALUES ($1, $2, $3, $4, 'demo-key', 'live')`,
      [orgId, appId, sha256, apiKey.slice(-4)],
    );

    await client.query('COMMIT');

    const curl =
      `curl -N http://localhost:3000/v1/chat/completions \\\n` +
      `  -H 'authorization: Bearer ${apiKey}' \\\n` +
      `  -H 'content-type: application/json' \\\n` +
      `  -d '{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hello"}]}'`;
    return { apiKey, curl };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}
