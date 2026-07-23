import { describe, it, expect } from 'vitest';
import type { Database, Queryable } from '../../../platform/db.js';
import { createAnalyticsService } from '../services/analytics.service.js';
import type {
  AnalyticsRepository,
  SumUsageOptions,
  UsageAggregateRow,
  UsageGroupBy,
} from '../types/analytics.types.js';

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
  rows: UsageAggregateRow[],
): AnalyticsRepository & { seen: { groupBy: UsageGroupBy; opts: SumUsageOptions }[] } {
  const seen: { groupBy: UsageGroupBy; opts: SumUsageOptions }[] = [];
  return {
    seen,
    async sumUsage(_tx, groupBy, opts) {
      seen.push({ groupBy, opts });
      return rows;
    },
  };
}

describe('analytics service', () => {
  it('getUsage reads inside the caller org tenant tx (RLS on, not platform admin)', async () => {
    const { db, calls } = fakeDb();
    const repo = fakeRepo([]);
    const svc = createAnalyticsService({ db, repo });

    await svc.getUsage('org-1', { groupBy: 'model' });

    expect(calls).toEqual([{ orgId: 'org-1', isPlatformAdmin: false }]);
    expect(repo.seen[0]?.groupBy).toBe('model');
    expect(repo.seen[0]?.opts.byOrg).toBe(false);
  });

  it('maps rows to buckets, coercing string aggregates to numbers', async () => {
    const { db } = fakeDb();
    const repo = fakeRepo([
      {
        group_key: 'gpt-4o',
        requests: '3',
        input_tokens: '100',
        output_tokens: '50',
        cost_usd: '0.012300',
      },
    ]);
    const svc = createAnalyticsService({ db, repo });

    const summary = await svc.getUsage('org-1', { groupBy: 'model' });

    expect(summary.object).toBe('analytics.usage');
    expect(summary.group_by).toBe('model');
    expect(summary.data).toEqual([
      { key: 'gpt-4o', requests: 3, input_tokens: 100, output_tokens: 50, cost_usd: 0.0123 },
    ]);
  });

  it('collapses a NULL group key (e.g. route_id) to a labeled bucket and treats NULL sums as 0', async () => {
    const { db } = fakeDb();
    const repo = fakeRepo([
      { group_key: null, requests: null, input_tokens: null, output_tokens: null, cost_usd: null },
    ]);
    const svc = createAnalyticsService({ db, repo });

    const summary = await svc.getUsage('org-1', { groupBy: 'route' });

    expect(summary.data[0]).toEqual({
      key: '(none)',
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    });
  });

  it('threads the time window through to the repository', async () => {
    const { db } = fakeDb();
    const repo = fakeRepo([]);
    const svc = createAnalyticsService({ db, repo });

    await svc.getUsage('org-1', {
      groupBy: 'day',
      from: '2026-07-01T00:00:00Z',
      to: '2026-07-24T00:00:00Z',
    });

    expect(repo.seen[0]?.opts).toMatchObject({
      byOrg: false,
      from: '2026-07-01T00:00:00Z',
      to: '2026-07-24T00:00:00Z',
    });
  });

  it('getUsageAllOrgs reads as platform admin and groups by org', async () => {
    const { db, calls } = fakeDb();
    const repo = fakeRepo([
      {
        group_key: 'org-a',
        requests: '10',
        input_tokens: '1',
        output_tokens: '1',
        cost_usd: '1.5',
      },
    ]);
    const svc = createAnalyticsService({ db, repo });

    const summary = await svc.getUsageAllOrgs({});

    expect(calls[0]?.isPlatformAdmin).toBe(true);
    expect(repo.seen[0]?.opts.byOrg).toBe(true);
    expect(summary.group_by).toBe('org');
    expect(summary.data[0]?.key).toBe('org-a');
  });
});
