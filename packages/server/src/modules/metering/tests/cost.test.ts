import { describe, it, expect } from 'vitest';
import { computeCostUsd } from '../lib/cost.js';

describe('computeCostUsd', () => {
  it('prices input + output tokens against the rate card', () => {
    // 1000 in @ $0.005/1k + 500 out @ $0.015/1k = 0.005 + 0.0075 = 0.0125
    expect(
      computeCostUsd(
        { inputTokens: 1000, outputTokens: 500 },
        { inputUsdPer1k: 0.005, outputUsdPer1k: 0.015 },
      ),
    ).toBeCloseTo(0.0125, 6);
  });

  it('costs zero when the model has no rate card', () => {
    expect(computeCostUsd({ inputTokens: 1000, outputTokens: 1000 }, {})).toBe(0);
  });

  it('costs zero for zero tokens', () => {
    expect(
      computeCostUsd({ inputTokens: 0, outputTokens: 0 }, { inputUsdPer1k: 1, outputUsdPer1k: 1 }),
    ).toBe(0);
  });
});
