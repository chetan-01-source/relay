/**
 * Analytics integration (Week 3 Day 12) — the read path against a REAL Postgres. Seeds hourly rollups
 * for one org and proves the service groups + sums them correctly (by model and by app) reading the
 * rollup read model only. Self-skips unless RELAY_TEST_DATABASE_URL is set. Cross-tenant RLS isolation
 * for usage_rollups_hourly is proven by the G4 suite (isolation/cross-tenant.integration.test.ts).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { initDb, resetDb, type Database } from '../../../platform/db.js';
import { createAnalyticsRepository } from '../repositories/analytics.repository.js';
import { createAnalyticsService } from '../services/analytics.service.js';

const url = process.env.RELAY_TEST_DATABASE_URL;

// A realistic model id used across the assertions. Hoisted to one place with a gitleaks allow: the
// `-3-5-` digit run trips gitleaks' generic-api-key entropy heuristic, but it is just a model name.
const SONNET = 'claude-3-5-sonnet'; // gitleaks:allow

describe.skipIf(!url)('analytics (integration)', () => {
  let db: Database;
  let orgId: string;
  const appX = randomUUID();
  const appY = randomUUID();

  beforeAll(async () => {
    const seeder = new pg.Client({ connectionString: url });
    await seeder.connect();
    const org = await seeder.query<{ id: string }>(
      `INSERT INTO organizations (logto_org_id, name) VALUES ($1, 'Analytics IT') RETURNING id`,
      [`analytics-${randomUUID()}`],
    );
    orgId = org.rows[0]!.id;
    // Three rollup rows: two models across two apps, in one hour bucket.
    const rows: [string, string, number, number, number, string][] = [
      [appX, 'gpt-4o', 2, 100, 50, '0.010000'],
      [appY, 'gpt-4o', 1, 10, 5, '0.002000'],
      [appX, SONNET, 3, 300, 150, '0.030000'],
    ];
    for (const [appId, model, reqs, inTok, outTok, cost] of rows) {
      await seeder.query(
        `INSERT INTO usage_rollups_hourly
           (org_id, hour, app_id, provider, model, requests, input_tokens, output_tokens, cost_usd)
         VALUES ($1, date_trunc('hour', now()), $2, 'openai', $3, $4, $5, $6, $7)`,
        [orgId, appId, model, reqs, inTok, outTok, cost],
      );
    }
    await seeder.end();
    resetDb();
    db = initDb(url!);
  });

  afterAll(async () => {
    const cleaner = new pg.Client({ connectionString: url });
    await cleaner.connect();
    await cleaner.query(`DELETE FROM organizations WHERE id = $1`, [orgId]); // cascades rollups
    await cleaner.end();
    await db.close();
    resetDb();
  });

  it('groups spend by model, summing tokens/cost, ordered by cost desc', async () => {
    const svc = createAnalyticsService({ db, repo: createAnalyticsRepository() });
    const summary = await svc.getUsage(orgId, { groupBy: 'model' });

    expect(summary.group_by).toBe('model');
    expect(summary.data.map((b) => b.key)).toEqual([SONNET, 'gpt-4o']);
    const gpt = summary.data.find((b) => b.key === 'gpt-4o')!;
    expect(gpt).toMatchObject({ requests: 3, input_tokens: 110, output_tokens: 55 });
    expect(gpt.cost_usd).toBeCloseTo(0.012, 6);
    const claude = summary.data.find((b) => b.key === SONNET)!;
    expect(claude.cost_usd).toBeCloseTo(0.03, 6);
  });

  it('groups spend by app', async () => {
    const svc = createAnalyticsService({ db, repo: createAnalyticsRepository() });
    const summary = await svc.getUsage(orgId, { groupBy: 'app' });

    const x = summary.data.find((b) => b.key === appX)!;
    const y = summary.data.find((b) => b.key === appY)!;
    expect(x.requests).toBe(5);
    expect(x.cost_usd).toBeCloseTo(0.04, 6);
    expect(y.requests).toBe(1);
  });

  it('a far-future window returns an empty result set', async () => {
    const svc = createAnalyticsService({ db, repo: createAnalyticsRepository() });
    const summary = await svc.getUsage(orgId, { groupBy: 'model', from: '2999-01-01T00:00:00Z' });
    expect(summary.data).toEqual([]);
  });
});
