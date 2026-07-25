import { describe, it, expect } from 'vitest';
import { sumUsageQuery } from '../queries/analytics.queries.js';

describe('sumUsageQuery', () => {
  it('maps each group_by to its fixed column (never user text) and groups by the key', () => {
    expect(sumUsageQuery('app', {}).text).toContain('app_id::text AS group_key');
    expect(sumUsageQuery('route', {}).text).toContain('route_id::text AS group_key');
    expect(sumUsageQuery('model', {}).text).toContain('model AS group_key');
    expect(sumUsageQuery('day', {}).text).toContain(
      "to_char(date_trunc('day', hour), 'YYYY-MM-DD') AS group_key",
    );
    for (const g of ['app', 'route', 'model', 'day'] as const) {
      expect(sumUsageQuery(g, {}).text).toContain('GROUP BY 1');
    }
  });

  it('reads only the rollups table, never the raw usage_events partitions', () => {
    const q = sumUsageQuery('model', {});
    expect(q.text).toContain('FROM usage_rollups_hourly');
    expect(q.text).not.toContain('usage_events');
  });

  it('has no filter and no bound values when no window is given', () => {
    const q = sumUsageQuery('model', {});
    expect(q.values).toEqual([]);
    expect(q.text).not.toContain('WHERE');
  });

  it('binds from/to as $-params (never interpolated) and casts to timestamptz', () => {
    const q = sumUsageQuery('day', { from: '2026-07-01T00:00:00Z', to: '2026-07-24T00:00:00Z' });
    expect(q.values).toEqual(['2026-07-01T00:00:00Z', '2026-07-24T00:00:00Z']);
    expect(q.text).toContain('hour >= $1::timestamptz');
    expect(q.text).toContain('hour < $2::timestamptz');
  });

  it('binds only `from` when `to` is absent (placeholder index stays $1)', () => {
    const q = sumUsageQuery('model', { from: '2026-07-01T00:00:00Z' });
    expect(q.values).toEqual(['2026-07-01T00:00:00Z']);
    expect(q.text).toContain('hour >= $1::timestamptz');
    expect(q.text).not.toContain('hour <');
  });

  it('byOrg keys by org_id, ignoring the group_by argument (cross-org admin summary)', () => {
    const q = sumUsageQuery('model', { byOrg: true });
    expect(q.text).toContain('org_id::text AS group_key');
    expect(q.text).not.toContain('model AS group_key');
  });

  it('org-scoped read adds an explicit org_id filter bound first (correct even if RLS is bypassed)', () => {
    const q = sumUsageQuery('model', { orgId: 'org-1', from: '2026-07-01T00:00:00Z' });
    expect(q.text).toContain('org_id = $1');
    expect(q.text).toContain('hour >= $2::timestamptz');
    expect(q.values).toEqual(['org-1', '2026-07-01T00:00:00Z']);
  });

  it('the cross-org admin variant does NOT filter by a single org', () => {
    const q = sumUsageQuery('model', { byOrg: true, orgId: 'org-1' });
    expect(q.text).not.toContain('org_id = $');
  });
});
