/**
 * Traffic repository integration (Week 3 Day 13) — proves the read model runs against real
 * usage_events rows: the cost::text cast survives as a number, getTrace correlates a request id, and
 * listRecent orders newest-first. Self-skips unless RELAY_TEST_DATABASE_URL is set (a superuser URL is
 * fine — cross-tenant RLS is proven by the isolation suite). The org is deleted on teardown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { initDb, resetDb, type Database } from '../../../platform/db.js';
import { createTrafficService } from '../services/traffic.service.js';
import { createTrafficRepository } from '../repositories/traffic.repository.js';

const url = process.env.RELAY_TEST_DATABASE_URL;

describe.skipIf(!url)('traffic repository (integration)', () => {
  let db: Database;
  let orgId: string;
  const traceId = `trace-${randomUUID()}`;

  beforeAll(async () => {
    const seeder = new pg.Client({ connectionString: url });
    await seeder.connect();
    const org = await seeder.query<{ id: string }>(
      `INSERT INTO organizations (logto_org_id, name) VALUES ($1, 'Traffic IT') RETURNING id`,
      [`traffic-${randomUUID()}`],
    );
    orgId = org.rows[0]!.id;
    // Two events sharing one trace id (e.g. a rate-limited attempt then the served call).
    for (const [status, cost] of [
      ['rate_limited', '0.000000'],
      ['ok', '0.001234'],
    ] as const) {
      await seeder.query(
        `INSERT INTO usage_events
           (org_id, app_id, request_id, provider, model, input_tokens, output_tokens, cost_usd, status, latency_ms)
         VALUES ($1, $2, $3, 'openai', 'gpt-4o', 100, 50, $4, $5, 12)`,
        [orgId, randomUUID(), traceId, cost, status],
      );
    }
    await seeder.end();
    resetDb();
    db = initDb(url!);
  });

  afterAll(async () => {
    const cleaner = new pg.Client({ connectionString: url });
    await cleaner.connect();
    await cleaner.query(`DELETE FROM usage_events WHERE org_id = $1`, [orgId]);
    await cleaner.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await cleaner.end();
    await db.close();
    resetDb();
  });

  it('getTrace returns both events for the request id, cost coerced to a number', async () => {
    const svc = createTrafficService({ db, repo: createTrafficRepository() });
    const events = await svc.getTrace(orgId, traceId);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.request_id === traceId)).toBe(true);
    const served = events.find((e) => e.status === 'ok')!;
    expect(served.cost_usd).toBe(0.001234);
    expect(typeof served.cost_usd).toBe('number');
    // getByRequestId orders oldest-first → the rate_limited attempt precedes the served call
    expect(events[0]!.status).toBe('rate_limited');
  });

  it('listRecent surfaces the seeded events, newest-first', async () => {
    const svc = createTrafficService({ db, repo: createTrafficRepository() });
    const recent = await svc.listRecent(orgId, { limit: 100 });
    expect(recent.some((e) => e.request_id === traceId)).toBe(true);
    const onlyErrors = await svc.listRecent(orgId, { limit: 100, status: 'rate_limited' });
    expect(onlyErrors.every((e) => e.status === 'rate_limited')).toBe(true);
  });
});
