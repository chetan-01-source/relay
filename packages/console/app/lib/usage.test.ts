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
  it('keeps large amounts readable at 2 dp', () => {
    expect(formatUsd(1234.5678)).toBe('$1234.57');
    expect(formatUsd(1)).toBe('$1.00');
  });

  it('uses 4 dp for sub-dollar, above-cent amounts', () => {
    expect(formatUsd(0.0123)).toBe('$0.0123');
    expect(formatUsd(0.01)).toBe('$0.0100');
  });

  // Regression: a short gpt-4o-mini call costs ~$0.000006. At a flat 4 dp that rendered as
  // "$0.0000", which reads as "usage isn't being tracked" rather than "this was very cheap".
  it('shows the full stored precision for tiny amounts instead of collapsing to zero', () => {
    expect(formatUsd(0.000012)).toBe('$0.000012');
    expect(formatUsd(0.000006)).toBe('$0.000006');
  });

  it('distinguishes "smaller than we store" from "nothing"', () => {
    // cost_usd is numeric(14,6), so 6 dp is the floor — below it, say so rather than print $0.00.
    expect(formatUsd(0.0000001)).toBe('<$0.000001');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('handles negatives and non-finite input without emitting NaN', () => {
    expect(formatUsd(-2.5)).toBe('-$2.50');
    expect(formatUsd(-0.000012)).toBe('-$0.000012');
    expect(formatUsd(Number.NaN)).toBe('$0.00');
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
