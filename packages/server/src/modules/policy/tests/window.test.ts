import { describe, it, expect } from 'vitest';
import { budgetWindow, budgetKey } from '../lib/window.js';

describe('budgetWindow', () => {
  it('stamps the UTC calendar day for a daily budget', () => {
    expect(budgetWindow('daily', new Date('2026-08-10T00:05:00Z')).stamp).toBe('2026-08-10');
  });

  it('stamps the UTC calendar month for a monthly budget', () => {
    expect(budgetWindow('monthly', new Date('2026-08-10T00:05:00Z')).stamp).toBe('2026-08');
  });

  // THE regression this module exists for. The old key was `budget:{org}:{period}` with no calendar
  // window, and both Lua scripts end in `SET … EX ttl`, refreshing the expiry on every write — so a
  // counter under steady traffic never expired and a "daily" budget accumulated forever.
  it('gives consecutive days DIFFERENT stamps, so a new period starts at zero', () => {
    const before = budgetWindow('daily', new Date('2026-08-09T23:59:59Z'));
    const after = budgetWindow('daily', new Date('2026-08-10T00:00:01Z'));
    expect(before.stamp).not.toBe(after.stamp);
  });

  it('gives consecutive months different stamps', () => {
    expect(budgetWindow('monthly', new Date('2026-08-31T23:59:59Z')).stamp).toBe('2026-08');
    expect(budgetWindow('monthly', new Date('2026-09-01T00:00:01Z')).stamp).toBe('2026-09');
  });

  it('keeps the same stamp across a day, so spend accumulates within the period', () => {
    const morning = budgetWindow('daily', new Date('2026-08-10T00:05:00Z'));
    const evening = budgetWindow('daily', new Date('2026-08-10T23:00:00Z'));
    expect(morning.stamp).toBe(evening.stamp);
  });

  describe('ttl', () => {
    it('is the time left in the window plus settle grace, not a fixed span', () => {
      // 1h before UTC midnight → 3600s remaining + 3600s grace.
      const window = budgetWindow('daily', new Date('2026-08-10T23:00:00Z'));
      expect(window.ttlSeconds).toBe(3600 + 3600);
    });

    it('shrinks as the window closes', () => {
      const early = budgetWindow('daily', new Date('2026-08-10T01:00:00Z'));
      const late = budgetWindow('daily', new Date('2026-08-10T22:00:00Z'));
      expect(early.ttlSeconds).toBeGreaterThan(late.ttlSeconds);
    });

    it('stays positive right at the boundary — SET EX rejects a non-positive TTL', () => {
      expect(budgetWindow('daily', new Date('2026-08-10T23:59:59Z')).ttlSeconds).toBeGreaterThan(0);
      expect(budgetWindow('monthly', new Date('2026-08-31T23:59:59Z')).ttlSeconds).toBeGreaterThan(
        0,
      );
    });

    it('spans the rest of the month for a monthly budget', () => {
      const window = budgetWindow('monthly', new Date('2026-08-01T00:00:00Z'));
      // 31 days in August, plus the grace hour.
      expect(window.ttlSeconds).toBe(31 * 24 * 3600 + 3600);
    });

    it('handles a leap February', () => {
      const window = budgetWindow('monthly', new Date('2028-02-01T00:00:00Z'));
      expect(window.ttlSeconds).toBe(29 * 24 * 3600 + 3600);
    });
  });
});

describe('budgetKey', () => {
  it('separates an application counter from the org-wide one', () => {
    const org = budgetKey('org-1', null, 'daily', '2026-08-10');
    const app = budgetKey('org-1', 'app-1', 'daily', '2026-08-10');
    expect(org).toBe('budget:org-1:org:daily:2026-08-10');
    expect(app).toBe('budget:org-1:app-1:daily:2026-08-10');
    expect(org).not.toBe(app);
  });

  it('separates periods, so a daily ceiling never spends the monthly counter', () => {
    expect(budgetKey('org-1', null, 'daily', '2026-08-10')).not.toBe(
      budgetKey('org-1', null, 'monthly', '2026-08'),
    );
  });

  it('separates orgs', () => {
    expect(budgetKey('org-1', null, 'daily', '2026-08-10')).not.toBe(
      budgetKey('org-2', null, 'daily', '2026-08-10'),
    );
  });
});
