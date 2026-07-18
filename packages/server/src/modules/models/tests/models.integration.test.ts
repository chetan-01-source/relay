/**
 * Integration test — models repository against a REAL Postgres (playbook §12: testing strategy).
 * Self-skips unless RELAY_TEST_DATABASE_URL is set, so `pnpm turbo test` stays green offline / in CI.
 *
 * Run locally:
 *   make up                                   # brings up postgres + applies migrations + seed
 *   RELAY_TEST_DATABASE_URL="postgres://relay_app:<pw>@localhost:5432/relay" \
 *     pnpm --filter @relay/server test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, resetDb, type Database } from '../../../platform/db.js';
import { createModelsRepository } from '../repositories/models.repository.js';

const url = process.env.RELAY_TEST_DATABASE_URL;

describe.skipIf(!url)('models.repository (integration)', () => {
  let db: Database;

  beforeAll(() => {
    resetDb();
    db = initDb(url!);
  });
  afterAll(async () => {
    await db.close();
    resetDb();
  });

  it('list() returns the seeded catalog rows in stable order', async () => {
    const repo = createModelsRepository(db);
    const rows = await repo.list();
    expect(rows.length).toBeGreaterThanOrEqual(4);
    // ordered by provider then model
    const ids = rows.map((r) => `${r.provider}/${r.model}`);
    expect([...ids]).toEqual([...ids].sort());
    expect(ids).toContain('openai/gpt-4o');
  });

  it('getById() finds a seeded model and returns null for the unknown', async () => {
    const repo = createModelsRepository(db);
    expect((await repo.getById('gpt-4o'))?.provider).toBe('openai');
    expect(await repo.getById('does-not-exist')).toBeNull();
  });
});
