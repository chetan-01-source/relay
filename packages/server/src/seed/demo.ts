/**
 * Demo seed (PRD Day 5) — creates one fully-formed tenant so `make up` yields a working curl:
 * org → app → provider credential (envelope-encrypted) → route → target → a fresh virtual key.
 *
 * Ops script, not a request module — runs as the migration role (superuser, bypasses RLS) and uses
 * inline parametrized SQL (still injection-safe). Idempotent by reset: the demo org's child rows are
 * cleared and re-seeded each run, and a new key is minted and printed (plaintext is never recoverable).
 */
import pg from 'pg';
import { mintVirtualKey, sealCredential } from '../platform/crypto.js';

export interface DemoSeedResult {
  /** Plaintext key — the caller writes it to a secured file, never to logs. */
  apiKey: string;
  /** Last 4 chars, safe to display. */
  last4: string;
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

    // mint a fresh virtual key — shown once (rk_live_<keyId>.<secret>). Only the public key_id
    // selector and a peppered PBKDF2 verifier of the SECRET half are stored (ADR virtual-key-format).
    const minted = mintVirtualKey(masterKey, 'live');
    await client.query(
      `INSERT INTO virtual_keys (org_id, app_id, key_id, key_sha256, last4, name, environment)
       VALUES ($1, $2, $3, $4, $5, 'demo-key', 'live')`,
      [orgId, appId, minted.keyId, minted.secretVerifier, minted.last4],
    );

    await client.query('COMMIT');

    // Return the raw pieces only; formatting/surfacing (to a secured file, never logs) is the caller's job.
    return { apiKey: minted.plaintext, last4: minted.last4 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}
