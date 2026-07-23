import { describe, it, expect } from 'vitest';
import { summarizeUsage, formatUsd } from './usage';
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
