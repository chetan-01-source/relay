/**
 * Metering integration (Week 3 Day 11) — flush + rollup against a REAL Postgres. Proves the batch
 * INSERT lands usage_events and the rollup worker aggregates them into usage_rollups_hourly. Self-skips
 * unless RELAY_TEST_DATABASE_URL is set. A superuser URL is fine here (RLS isolation is the isolation
 * suite's job); this test verifies the SQL + aggregation.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { initDb, resetDb, type Database } from '../../../platform/db.js';
import { createMeteringService } from '../services/metering.service.js';
import type { UsageEvent } from '../types/metering.types.js';

const url = process.env.RELAY_TEST_DATABASE_URL;

function event(orgId: string, over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    orgId,
    appId: randomUUID(),
    keyId: null,
    routeId: null,
    requestId: `trace-${randomUUID()}`,
    provider: 'openai',
    model: 'gpt-4o',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.001,
    status: 'ok',
    latencyMs: 12,
    ...over,
  };
}

describe.skipIf(!url)('metering (integration)', () => {
  let db: Database;
  let orgId: string;

  beforeAll(async () => {
    const seeder = new pg.Client({ connectionString: url });
    await seeder.connect();
    const org = await seeder.query<{ id: string }>(
      `INSERT INTO organizations (logto_org_id, name) VALUES ($1, 'Metering IT') RETURNING id`,
      [`meter-${randomUUID()}`],
    );
    orgId = org.rows[0]!.id;
    await seeder.end();
    resetDb();
    db = initDb(url!);
  });

  afterAll(async () => {
    await db.withTenant('00000000-0000-0000-0000-000000000000', { isPlatformAdmin: true }, (tx) =>
      tx.run({ text: `DELETE FROM usage_events WHERE org_id = $1`, values: [orgId] }),
    );
    const cleaner = new pg.Client({ connectionString: url });
    await cleaner.connect();
    await cleaner.query(`DELETE FROM organizations WHERE id = $1`, [orgId]); // cascades rollups
    await cleaner.end();
    await db.close();
    resetDb();
  });

  it('flushes queued events to usage_events, then rolls them up hourly', async () => {
    const svc = createMeteringService({
      db,
      queueMax: 100,
      flushIntervalMs: 100_000,
      rollupIntervalMs: 100_000,
    });
    svc.recordUsage(event(orgId));
    svc.recordUsage(event(orgId, { inputTokens: 200, outputTokens: 100, costUsd: 0.002 }));
    await svc.flush();

    const events = await db.withTenant(orgId, { isPlatformAdmin: false }, (tx) =>
      tx.run<{ n: string }>({
        text: `SELECT count(*) AS n FROM usage_events WHERE org_id = $1`,
        values: [orgId],
      }),
    );
    expect(Number(events[0]!.n)).toBe(2);

    await svc.rollup(Date.now());
    const rollups = await db.withTenant(orgId, { isPlatformAdmin: false }, (tx) =>
      tx.run<{ requests: string; input_tokens: string; cost_usd: string }>({
        text: `SELECT sum(requests) AS requests, sum(input_tokens) AS input_tokens, sum(cost_usd) AS cost_usd
                 FROM usage_rollups_hourly WHERE org_id = $1`,
        values: [orgId],
      }),
    );
    expect(Number(rollups[0]!.requests)).toBe(2);
    expect(Number(rollups[0]!.input_tokens)).toBe(300);
    expect(Number(rollups[0]!.cost_usd)).toBeCloseTo(0.003, 6);
  });
});
