/**
 * The registry and the database must agree on what a provider is.
 *
 * `packages/shared/src/providers.ts` is the source of truth, but Postgres enforces its own CHECK
 * constraint so a bad value cannot be written even by a direct psql session. Two lists means they
 * can drift, and the failure is silent in the worst direction: the console offers a provider, the
 * user fills in a key, and the INSERT fails with a constraint violation that names no useful cause.
 *
 * This test is the seam. It reads the migration and compares.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from 'relay-shared';

/** The migration that owns the constraint. Later migrations may widen it — see the guard below. */
const MIGRATION = '0019_provider_registry.sql';

function migrationsDir(): string {
  // Vitest runs from packages/server; the migrations live at the repo root.
  return path.resolve(process.cwd(), '../../db/migrations');
}

/** Provider ids named inside the CHECK (...) list of the migration. */
function providersInMigration(): string[] {
  const sql = readFileSync(path.join(migrationsDir(), MIGRATION), 'utf8');
  const check = /CHECK\s*\(provider IN\s*\(([\s\S]*?)\)\)/.exec(sql);
  if (!check) throw new Error(`no provider CHECK constraint found in ${MIGRATION}`);
  return Array.from(check[1]!.matchAll(/'([^']+)'/g)).map((m) => m[1]!);
}

describe('provider registry ↔ database constraint', () => {
  it('allows exactly the providers the registry defines', () => {
    // Sorted: the orders serve different masters — the registry's is the console's dropdown order,
    // the SQL's is readability — and neither should be forced to follow the other.
    expect([...providersInMigration()].sort()).toEqual([...PROVIDER_IDS].sort());
  });

  it('names a constraint that later migrations can find to widen it', () => {
    const sql = readFileSync(path.join(migrationsDir(), MIGRATION), 'utf8');
    expect(sql).toContain('provider_credentials_provider_check');
  });
});
