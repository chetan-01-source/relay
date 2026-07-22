import { describe, it, expect, vi } from 'vitest';
import type { Database, Queryable } from '../../../platform/db.js';
import { createMeteringService } from '../services/metering.service.js';
import type { MeteringRepository, UsageEvent } from '../types/metering.types.js';

function event(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    orgId: 'org-1',
    appId: 'app-1',
    keyId: 'key-1',
    routeId: 'route-1',
    requestId: 'trace-1',
    provider: 'openai',
    model: 'gpt-4o',
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.001,
    status: 'ok',
    latencyMs: 12,
    ...over,
  };
}

function fakeDb(): {
  db: Database;
  calls: { orgId: string; isPlatformAdmin: boolean | undefined }[];
} {
  const calls: { orgId: string; isPlatformAdmin: boolean | undefined }[] = [];
  const db = {
    withTenant: async (
      orgId: string,
      scope: { isPlatformAdmin?: boolean },
      fn: (tx: Queryable) => Promise<unknown>,
    ) => {
      calls.push({ orgId, isPlatformAdmin: scope.isPlatformAdmin });
      return fn({ run: async () => [] });
    },
  } as unknown as Database;
  return { db, calls };
}

function fakeRepo(
  orgsWithUsage: string[] = [],
): MeteringRepository & { inserted: UsageEvent[][]; rollups: string[] } {
  const inserted: UsageEvent[][] = [];
  const rollups: string[] = [];
  return {
    inserted,
    rollups,
    async insertEvents(_tx, events) {
      inserted.push(events);
    },
    async listOrgsWithUsageSince() {
      return orgsWithUsage;
    },
    async rebuildRollupsForOrgSince(_tx, _orgId, since) {
      rollups.push(since);
    },
  };
}

describe('metering service', () => {
  it('flush groups queued events by org, one tenant transaction each', async () => {
    const { db, calls } = fakeDb();
    const repo = fakeRepo();
    const svc = createMeteringService({
      db,
      repo,
      queueMax: 100,
      flushIntervalMs: 1000,
      rollupIntervalMs: 1000,
    });

    svc.recordUsage(event({ orgId: 'org-1' }));
    svc.recordUsage(event({ orgId: 'org-2' }));
    svc.recordUsage(event({ orgId: 'org-1' }));
    await svc.flush();

    expect(calls.map((c) => c.orgId).sort()).toEqual(['org-1', 'org-2']);
    expect(repo.inserted.flat()).toHaveLength(3);
  });

  it('flush is a no-op when nothing is queued', async () => {
    const { db, calls } = fakeDb();
    const repo = fakeRepo();
    const svc = createMeteringService({
      db,
      repo,
      queueMax: 100,
      flushIntervalMs: 1000,
      rollupIntervalMs: 1000,
    });
    await svc.flush();
    expect(calls).toHaveLength(0);
    expect(repo.inserted).toHaveLength(0);
  });

  it('drops the oldest event when the queue is full, flushing only what remains', async () => {
    const { db } = fakeDb();
    const repo = fakeRepo();
    const svc = createMeteringService({
      db,
      repo,
      queueMax: 1,
      flushIntervalMs: 1000,
      rollupIntervalMs: 1000,
    });
    svc.recordUsage(event({ requestId: 'first' }));
    svc.recordUsage(event({ requestId: 'second' })); // evicts 'first'
    await svc.flush();
    expect(repo.inserted.flat().map((e) => e.requestId)).toEqual(['second']);
  });

  it('rollup lists orgs as a platform admin, then rebuilds each in its own tenant tx', async () => {
    const { db, calls } = fakeDb();
    const repo = fakeRepo(['org-a', 'org-b']);
    const svc = createMeteringService({
      db,
      repo,
      queueMax: 100,
      flushIntervalMs: 1000,
      rollupIntervalMs: 1000,
    });
    await svc.rollup(Date.parse('2026-07-22T10:30:00Z'));
    expect(calls[0]?.isPlatformAdmin).toBe(true); // the org-listing read
    expect(
      calls
        .slice(1)
        .map((c) => c.orgId)
        .sort(),
    ).toEqual(['org-a', 'org-b']); // per-org rebuilds
    expect(calls.slice(1).every((c) => c.isPlatformAdmin === false)).toBe(true);
    expect(repo.rollups).toHaveLength(2);
  });

  it('a failing flush does not throw (best-effort, worker survives)', async () => {
    const db = {
      withTenant: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as Database;
    const svc = createMeteringService({
      db,
      repo: fakeRepo(),
      queueMax: 100,
      flushIntervalMs: 1000,
      rollupIntervalMs: 1000,
    });
    svc.recordUsage(event());
    await expect(svc.flush()).resolves.toBeUndefined();
  });

  it('start is idempotent and stop flushes what is queued', async () => {
    const { db, calls } = fakeDb();
    const repo = fakeRepo();
    const svc = createMeteringService({
      db,
      repo,
      queueMax: 100,
      flushIntervalMs: 100000,
      rollupIntervalMs: 100000,
    });
    svc.start();
    svc.start(); // no-op second call
    svc.recordUsage(event());
    await svc.stop();
    expect(calls).toHaveLength(1); // stop() drained the queue
  });
});
