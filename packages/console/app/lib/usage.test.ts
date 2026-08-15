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

describe('toDailySeries — gaps', () => {
  /**
   * The API returns a bucket only for days that had usage. Plotting those directly drew the 10th
   * and the 15th side by side, so the four silent days vanished and the x-axis stopped meaning
   * anything — a quiet week looked identical to a busy one.
   */
  it('emits every day in the window, with zeros where nothing was spent', () => {
    const summary = {
      data: [
        { key: '2026-06-10', cost_usd: 1.5, requests: 3 },
        { key: '2026-06-15', cost_usd: 2.5, requests: 5 },
      ],
    };

    const series = toDailySeries(summary, 30, { from: '2026-06-10', to: '2026-06-15' });

    expect(series.map((p) => p.date)).toEqual([
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
      '2026-06-13',
      '2026-06-14',
      '2026-06-15',
    ]);
    expect(series.map((p) => p.cost)).toEqual([1.5, 0, 0, 0, 0, 2.5]);
    expect(series[1]!.requests).toBe(0);
  });

  it('extends to the window edges even when the quiet days are at the ends', () => {
    // Without the window the series could only span days that returned data, so a window ending in
    // silence was cropped to the last busy day — the same bug in a different disguise.
    const summary = { data: [{ key: '2026-06-12', cost_usd: 1, requests: 1 }] };

    const series = toDailySeries(summary, 30, { from: '2026-06-10', to: '2026-06-14' });

    expect(series).toHaveLength(5);
    expect(series[0]!.date).toBe('2026-06-10');
    expect(series[4]!.date).toBe('2026-06-14');
  });

  it('crosses a month boundary correctly', () => {
    const series = toDailySeries({ data: [] }, 30, {
      from: '2026-01-30',
      to: '2026-02-02',
    });
    expect(series.map((p) => p.date)).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ]);
  });

  it('keeps the most recent days when the window is longer than the limit', () => {
    const series = toDailySeries({ data: [] }, 3, {
      from: '2026-06-01',
      to: '2026-06-10',
    });
    expect(series.map((p) => p.date)).toEqual(['2026-06-08', '2026-06-09', '2026-06-10']);
  });

  it('falls back to the span of the data when no window is given', () => {
    const summary = {
      data: [
        { key: '2026-06-13', cost_usd: 1, requests: 1 },
        { key: '2026-06-11', cost_usd: 2, requests: 2 },
      ],
    };
    expect(toDailySeries(summary as never).map((p) => p.date)).toEqual([
      '2026-06-11',
      '2026-06-12',
      '2026-06-13',
    ]);
  });

  it('returns nothing for an empty summary and no window', () => {
    expect(toDailySeries({ data: [] })).toEqual([]);
    expect(toDailySeries(null)).toEqual([]);
  });

  it('returns nothing for an inverted window rather than looping', () => {
    expect(toDailySeries({ data: [] }, 30, { from: '2026-06-10', to: '2026-06-01' })).toEqual([]);
  });
});
