import { describe, it, expect } from 'vitest';
import { summarizeUsage, formatUsd, toDailySeries, labelOrgUsage } from './usage';
import type { UsageSummary } from './api';

function summary(data: UsageSummary['data']): UsageSummary {
  return { object: 'analytics.usage', group_by: 'model', data } as UsageSummary;
}

describe('summarizeUsage', () => {
  it('sums requests/tokens/cost and picks the highest-spend bucket as topKey', () => {
    const totals = summarizeUsage(
      summary([
        { key: 'gpt-4o', requests: 3, input_tokens: 100, output_tokens: 50, cost_usd: 0.012 },
        { key: 'claude', requests: 2, input_tokens: 300, output_tokens: 150, cost_usd: 0.03 },
      ]),
    );
    expect(totals).toEqual({
      requests: 5,
      inputTokens: 400,
      outputTokens: 200,
      costUsd: expect.closeTo(0.042, 6),
      topKey: 'claude',
    });
  });

  it('returns zeroes and a null topKey for empty or missing data', () => {
    expect(summarizeUsage(null)).toEqual({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      topKey: null,
    });
    expect(summarizeUsage(summary([])).topKey).toBeNull();
  });
});

describe('formatUsd', () => {
  it('formats to 4 dp so sub-cent spend is visible', () => {
    expect(formatUsd(0.0123)).toBe('$0.0123');
    expect(formatUsd(0)).toBe('$0.0000');
  });
});

describe('labelOrgUsage', () => {
  const byOrg = (data: UsageSummary['data']): UsageSummary =>
    ({ object: 'analytics.usage', group_by: 'org', data }) as UsageSummary;

  it('resolves org names, sorts by cost descending, and falls back to the id when unknown', () => {
    const rows = labelOrgUsage(
      byOrg([
        { key: 'org-a', requests: 5, input_tokens: 0, output_tokens: 0, cost_usd: 0.1 },
        { key: 'org-b', requests: 9, input_tokens: 0, output_tokens: 0, cost_usd: 0.5 },
      ]),
      new Map([['org-a', 'Acme']]),
    );
    expect(rows).toEqual([
      { orgId: 'org-b', name: 'org-b', requests: 9, costUsd: 0.5 },
      { orgId: 'org-a', name: 'Acme', requests: 5, costUsd: 0.1 },
    ]);
  });

  it('is empty for missing data', () => {
    expect(labelOrgUsage(null, new Map())).toEqual([]);
  });
});

describe('toDailySeries', () => {
  it('sorts by date ascending and keeps the most recent N days', () => {
    const series = toDailySeries(
      summary([
        { key: '2026-07-03', requests: 3, input_tokens: 0, output_tokens: 0, cost_usd: 0.3 },
        { key: '2026-07-01', requests: 1, input_tokens: 0, output_tokens: 0, cost_usd: 0.1 },
        { key: '2026-07-02', requests: 2, input_tokens: 0, output_tokens: 0, cost_usd: 0.2 },
      ]),
      2,
    );
    expect(series.map((p) => p.date)).toEqual(['2026-07-02', '2026-07-03']);
    expect(series[0]).toEqual({ date: '2026-07-02', cost: 0.2, requests: 2 });
  });

  it('is empty for missing data', () => {
    expect(toDailySeries(null)).toEqual([]);
  });
});
