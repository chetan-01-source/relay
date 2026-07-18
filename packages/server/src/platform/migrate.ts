/**
 * Migration runner (PRD §4 Day 2 · playbook §9). Plain SQL, applied in filename order,
 * advisory-locked so concurrent deploys can't race, and CHECKSUMMED so an already-applied
 * migration can never be edited (additive-only discipline). Runs as the migration role
 * (postgres superuser) which bypasses RLS. Idempotent: re-running is a no-op.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const ADVISORY_LOCK_KEY = 4_919_071; // arbitrary fixed key, shared by all runners

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

async function resolveMigrationsDir(): Promise<string> {
  // Makefile runs from repo root; fall back to walking up from cwd.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'db', 'migrations');
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new Error('could not locate db/migrations directory');
}

export async function runMigrations(migrationDatabaseUrl: string): Promise<MigrateResult> {
  const dir = await resolveMigrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const client = new pg.Client({ connectionString: migrationDatabaseUrl });
  await client.connect();
  const result: MigrateResult = { applied: [], skipped: [] };

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = applied.get(file);

      if (prior !== undefined) {
        if (prior !== checksum) {
          throw new Error(
            `migration ${file} was modified after it was applied (checksum mismatch). ` +
              `Migrations are additive-only — add a new migration instead.`,
          );
        }
        result.skipped.push(file);
        continue;
      }

      // each migration in its own transaction: all-or-nothing
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    await client.end();
  }

  return result;
}
