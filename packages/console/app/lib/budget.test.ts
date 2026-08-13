import { describe, it, expect } from 'vitest';
import { periodWindow, budgetStatus, budgetFor, enforcementSummary } from './budget';

describe('periodWindow', () => {
  it('scopes a daily budget to the day itself', () => {
    expect(periodWindow('daily', new Date('2026-08-09T15:00:00Z'))).toEqual({
      from: '2026-08-09',
      to: '2026-08-09',
    });
  });

  it('scopes a monthly budget to the calendar month TO DATE, not a rolling 30 days', () => {
    // A monthly ceiling resets on the 1st; a rolling window would count spend it no longer counts.
    expect(periodWindow('monthly', new Date('2026-08-09T15:00:00Z'))).toEqual({
      from: '2026-08-01',
      to: '2026-08-09',
    });
  });

  it('handles the first of the month, where the window is a single day', () => {
    expect(periodWindow('monthly', new Date('2026-08-01T00:30:00Z'))).toEqual({
      from: '2026-08-01',
      to: '2026-08-01',
    });
  });

  it('uses UTC, matching how the rollups are bucketed', () => {
    // 23:30 UTC on the 9th is already the 10th in some local zones — the window must not drift.
    expect(periodWindow('daily', new Date('2026-08-09T23:30:00Z')).to).toBe('2026-08-09');
  });
});

describe('budgetStatus', () => {
  it('reports usage under the ceiling as ok', () => {
    const status = budgetStatus(10, 100);
    expect(status).toMatchObject({ percent: 10, tone: 'ok', remainingUsd: 90 });
  });

  it('warns from 80%, leaving runway to act before requests start failing', () => {
    expect(budgetStatus(79, 100).tone).toBe('ok');
    expect(budgetStatus(80, 100).tone).toBe('warn');
    expect(budgetStatus(99, 100).tone).toBe('warn');
  });

  it('flags reaching the ceiling as over, not warn', () => {
    expect(budgetStatus(100, 100).tone).toBe('over');
  });

  it('clamps the bar at 100% but keeps the true ratio for the copy', () => {
    const status = budgetStatus(250, 100);
    expect(status.percent).toBe(100);
    expect(status.ratio).toBe(2.5);
    expect(status.remainingUsd).toBe(0);
  });

  it('does not divide by a zero or invalid ceiling', () => {
    expect(budgetStatus(10, 0)).toMatchObject({ percent: 0, tone: 'ok' });
    expect(budgetStatus(10, Number.NaN).percent).toBe(0);
  });

  it('treats negative or invalid spend as zero rather than emitting NaN%', () => {
    expect(budgetStatus(-5, 100).percent).toBe(0);
    expect(budgetStatus(Number.NaN, 100).percent).toBe(0);
  });
});

describe('budgetFor', () => {
  const budgets = [
    { period: 'daily', app_id: null },
    { period: 'monthly', app_id: null },
    { period: 'monthly', app_id: 'app-1' },
  ];

  it('finds the org-wide ceiling for a period', () => {
    expect(budgetFor(budgets, 'monthly')).toEqual({ period: 'monthly', app_id: null });
  });

  it('finds an application ceiling without confusing it for the org one', () => {
    // Matching on period alone would return the app row here and show a limit on the wrong card.
    expect(budgetFor(budgets, 'monthly', 'app-1')).toEqual({ period: 'monthly', app_id: 'app-1' });
  });

  it('does not fall back to the org ceiling when an app has none of its own', () => {
    expect(budgetFor(budgets, 'daily', 'app-1')).toBeNull();
  });

  it('returns null when the period has no ceiling — not undefined', () => {
    expect(budgetFor([{ period: 'daily', app_id: null }], 'monthly')).toBeNull();
    expect(budgetFor([], 'daily')).toBeNull();
  });
});

describe('enforcementSummary', () => {
  it('spells out what actually happens, since the two modes behave very differently', () => {
    expect(enforcementSummary(true)).toContain('rejected');
    expect(enforcementSummary(false)).toContain('never blocked');
  });
});
