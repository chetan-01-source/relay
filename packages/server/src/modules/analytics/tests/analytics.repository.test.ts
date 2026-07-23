import { describe, it, expect } from 'vitest';
import type { Queryable, SqlQuery } from '../../../platform/db.js';
import { createAnalyticsRepository } from '../repositories/analytics.repository.js';
import type { UsageAggregateRow } from '../types/analytics.types.js';

/** A fake Queryable that captures the executed query and returns a canned row set. */
function fakeTx(rows: UsageAggregateRow[]): { tx: Queryable; last?: SqlQuery } {
  const holder: { tx: Queryable; last?: SqlQuery } = {
    tx: {
      async run<R>(query: SqlQuery): Promise<R[]> {
        holder.last = query;
        return rows as unknown as R[];
      },
    },
  };
  return holder;
}

describe('analytics repository', () => {
  it('runs the sum query built for the given group_by/options and returns the rows', async () => {
    const rows: UsageAggregateRow[] = [
      {
        group_key: 'gpt-4o',
        requests: '1',
        input_tokens: '2',
        output_tokens: '3',
        cost_usd: '0.1',
      },
    ];
    const holder = fakeTx(rows);
    const repo = createAnalyticsRepository();

    const out = await repo.sumUsage(holder.tx, 'model', { from: '2026-07-01T00:00:00Z' });

    expect(out).toBe(rows);
    expect(holder.last?.text).toContain('FROM usage_rollups_hourly');
    expect(holder.last?.values).toEqual(['2026-07-01T00:00:00Z']);
  });
});
