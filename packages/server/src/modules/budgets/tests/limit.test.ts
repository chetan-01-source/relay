/**
 * Budget-limit scale. `budgets.limit_usd` is `numeric(12,4)`, and Postgres ROUNDS anything longer
 * rather than refusing it — so these cases are the difference between enforcing the ceiling the
 * operator chose and enforcing a different one silently.
 */
import { describe, expect, it } from 'vitest';
import { hasStorableScale } from '../lib/limit.js';

describe('hasStorableScale', () => {
  it.each([50, 5.5, 0.25, 1.0001, 0.0001, 99_999_999.9999, 1000])('stores %s exactly', (value) => {
    expect(hasStorableScale(value)).toBe(true);
  });

  it.each([1.00001, 0.000000001, 0.12345, 2.000005])('rejects %s as too fine', (value) => {
    expect(hasStorableScale(value)).toBe(false);
  });

  /**
   * The float trap this function exists for: 0.07 * 1e4 is 700.0000000000001 as a binary double, so
   * a naive Number.isInteger check would reject a 7-cent limit the column stores perfectly.
   */
  it('is not fooled by binary representation error', () => {
    expect(0.07 * 1e4).not.toBe(700); // the premise
    expect(hasStorableScale(0.07)).toBe(true); // the behaviour
    expect(hasStorableScale(8.7)).toBe(true);
    expect(hasStorableScale(29.99)).toBe(true);
  });

  it('accepts an integer limit, the overwhelmingly common case', () => {
    expect(hasStorableScale(1)).toBe(true);
    expect(hasStorableScale(500)).toBe(true);
  });
});
