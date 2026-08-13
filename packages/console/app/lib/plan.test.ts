import { describe, expect, it } from 'vitest';
import type { EffectivePlan } from './api';
import {
  formatLimit,
  formatPrice,
  isEnabled,
  isNearFull,
  quotaRows,
  sourceLabel,
  sourceOf,
  statusNote,
} from './plan';

function plan(over: Record<string, unknown> = {}): EffectivePlan {
  return {
    object: 'plan.effective',
    plan: { code: 'pro', name: 'Pro', tier: 2 },
    status: 'active',
    lapsed: false,
    trial_ends_at: null,
    current_period_end: null,
    limits: {},
    ...over,
  } as unknown as EffectivePlan;
}

describe('quotaRows', () => {
  it('computes the fill ratio and flags an exhausted quota', () => {
    const rows = quotaRows(
      plan({ limits: { 'apps.max': { value: 10, source: 'plan', used: 10 } } }),
    );
    const apps = rows.find((r) => r.key === 'apps.max')!;
    expect(apps.ratio).toBe(1);
    expect(apps.exhausted).toBe(true);
    expect(apps.over).toBe(false);
  });

  it('flags an org left over its ceiling by a downgrade, and caps the bar at full', () => {
    const rows = quotaRows(
      plan({ limits: { 'apps.max': { value: 1, source: 'plan', used: 40 } } }),
    );
    const apps = rows.find((r) => r.key === 'apps.max')!;
    expect(apps.over).toBe(true);
    expect(apps.ratio).toBe(1); // never renders a bar wider than its track
  });

  it('has no ratio when the limit is unlimited', () => {
    const rows = quotaRows(
      plan({ limits: { 'apps.max': { value: null, source: 'plan', used: 4 } } }),
    );
    const apps = rows.find((r) => r.key === 'apps.max')!;
    expect(apps.ratio).toBeNull();
    expect(apps.exhausted).toBe(false);
  });

  it('treats a missing limit as unlimited and unused rather than throwing', () => {
    const rows = quotaRows(plan());
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.limit === null && r.used === 0)).toBe(true);
  });
});

describe('isNearFull', () => {
  it('turns amber at 80% and not before', () => {
    expect(isNearFull(0.79)).toBe(false);
    expect(isNearFull(0.8)).toBe(true);
  });

  it('is false once full — that is a different state with its own colour', () => {
    expect(isNearFull(1)).toBe(false);
    expect(isNearFull(null)).toBe(false);
  });
});

describe('formatLimit', () => {
  it('renders an absent ceiling as Unlimited, never as 0 or a dash', () => {
    expect(formatLimit('apps.max', null)).toBe('Unlimited');
    expect(formatLimit('apps.max', undefined)).toBe('Unlimited');
  });

  it('renders spend as currency and retention in days', () => {
    expect(formatLimit('spend.monthly_usd.max', 2500)).toBe('$2,500');
    expect(formatLimit('retention.traffic_days', 30)).toBe('30 days');
    expect(formatLimit('retention.traffic_days', 1)).toBe('1 day');
  });

  it('renders a capability as included or not', () => {
    expect(formatLimit('cache.exact', true)).toBe('Included');
    expect(formatLimit('cache.exact', false)).toBe('Not included');
  });

  it('groups large counts', () => {
    expect(formatLimit('rate.tpm', 6000000)).toBe('6,000,000');
  });
});

describe('formatPrice', () => {
  it('says Free rather than $0', () => {
    expect(formatPrice(0)).toBe('Free');
  });

  it('returns null for a plan quoted on request', () => {
    expect(formatPrice(null)).toBeNull();
  });
});

describe('provenance', () => {
  it('falls back to the plan for an unknown source', () => {
    expect(sourceOf({ source: 'nonsense' })).toBe('plan');
    expect(sourceOf({ source: 'override' })).toBe('override');
  });

  it('describes each source in words', () => {
    expect(sourceLabel('override')).toMatch(/Custom/);
    expect(sourceLabel('plan')).toMatch(/plan/);
  });
});

describe('isEnabled', () => {
  it('is permissive when nothing has an opinion — matching the gateway default', () => {
    expect(isEnabled(plan(), 'cache.exact')).toBe(true);
  });

  it('is off only when explicitly false', () => {
    expect(isEnabled(plan({ limits: { 'cache.exact': { value: false } } }), 'cache.exact')).toBe(
      false,
    );
  });
});

describe('statusNote', () => {
  it('says nothing when everything is ordinary', () => {
    expect(statusNote(plan())).toBeNull();
  });

  it('explains why limits tightened after a trial ended', () => {
    const note = statusNote(
      plan({ status: 'trialing', lapsed: true, trial_ends_at: '2026-08-03T00:00:00Z' }),
    );
    expect(note?.tone).toBe('warning');
    expect(note?.message).toContain('trial ended');
    expect(note?.message).toContain('Aug');
  });

  it('reassures during a grace period rather than alarming', () => {
    const note = statusNote(plan({ status: 'past_due', lapsed: false }));
    expect(note?.message).toContain('grace period');
  });

  it('reports a running trial without a warning tone', () => {
    const note = statusNote(plan({ status: 'trialing', trial_ends_at: '2999-01-01T00:00:00Z' }));
    expect(note?.tone).toBe('neutral');
  });
});
