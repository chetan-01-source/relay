/**
 * The resolution rules are the part of the plan layer everything else trusts, and they are pure —
 * so they are tested directly, without a database.
 */
import { describe, expect, it } from 'vitest';
import {
  FEATURE_LIMIT_KEYS,
  LIMIT_KEYS,
  defaultFor,
  enabled,
  flatten,
  isUnlimited,
  numeric,
  resolveLimits,
  sanitizeLimits,
  tighter,
  unlimitedLimits,
} from '../lib/limits.js';

describe('resolveLimits precedence', () => {
  it('takes the plan value when nothing else has an opinion', () => {
    const resolved = resolveLimits({ plan: { 'apps.max': 10 } });
    expect(resolved['apps.max']).toEqual({ value: 10, source: 'plan' });
  });

  it('lets a subscription override beat the plan', () => {
    const resolved = resolveLimits({ plan: { 'apps.max': 10 }, overrides: { 'apps.max': 40 } });
    expect(resolved['apps.max']).toEqual({ value: 40, source: 'override' });
  });

  it('lets an org_features row beat both — it is the support escape hatch', () => {
    const resolved = resolveLimits({
      plan: { 'cache.exact': false },
      overrides: { 'cache.exact': false },
      features: { 'cache.exact': true },
    });
    expect(resolved['cache.exact']).toEqual({ value: true, source: 'org_feature' });
  });

  it('resolves every declared key, never leaving a hole for a consumer to handle', () => {
    const resolved = resolveLimits({ plan: {} });
    for (const key of LIMIT_KEYS) {
      expect(resolved[key]).toEqual({ value: defaultFor(key), source: 'default' });
    }
  });

  it('defaults permissively: numeric keys unlimited, capabilities on', () => {
    // A key added to the vocabulary must not start rejecting traffic for orgs on older plans.
    const resolved = resolveLimits({ plan: {} });
    expect(numeric(resolved, 'apps.max')).toBeNull();
    for (const key of FEATURE_LIMIT_KEYS) expect(enabled(resolved, key)).toBe(true);
  });

  it('treats an explicit null as "unlimited", not as "unset"', () => {
    const resolved = resolveLimits({ plan: { 'apps.max': 10 }, overrides: { 'apps.max': null } });
    expect(resolved['apps.max']).toEqual({ value: null, source: 'override' });
    expect(isUnlimited(resolved['apps.max'].value)).toBe(true);
  });
});

describe('sanitizeLimits', () => {
  it('drops keys outside the declared vocabulary', () => {
    expect(sanitizeLimits({ 'apps.max': 5, 'apps.maxx': 5, nonsense: true })).toEqual({
      'apps.max': 5,
    });
  });

  it('ignores a malformed value rather than coercing it', () => {
    // A typo in an overrides blob must fall through to the layer below, not become `false`/`0` and
    // silently switch a capability off in production.
    expect(sanitizeLimits({ 'cache.exact': 'yes', 'apps.max': -3 })).toEqual({});
  });

  it('survives a non-object payload', () => {
    expect(sanitizeLimits(null)).toEqual({});
    expect(sanitizeLimits('nope')).toEqual({});
  });
});

describe('tighter', () => {
  it('returns the smaller ceiling', () => {
    expect(tighter(600, 6000)).toBe(600);
  });

  it('treats null as "no opinion" on either side', () => {
    expect(tighter(null, 600)).toBe(600);
    expect(tighter(600, null)).toBe(600);
    expect(tighter(null, null)).toBeNull();
  });
});

describe('the self-hosted plan', () => {
  it('is unlimited on every numeric key and on for every capability', () => {
    const resolved = resolveLimits({ plan: unlimitedLimits() });
    const values = flatten(resolved);
    for (const key of LIMIT_KEYS) {
      expect(values[key]).toBe(FEATURE_LIMIT_KEYS.includes(key as never) ? true : null);
    }
  });
});
