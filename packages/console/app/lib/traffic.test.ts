import { describe, it, expect } from 'vitest';
import { parseStatus, statusVariant, mergeEvent } from './traffic';
import type { TrafficEvent } from './api';

const event = (id: string, status = 'ok'): TrafficEvent =>
  ({ id, status, created_at: '2026-03-01T00:00:00Z' }) as TrafficEvent;

describe('parseStatus', () => {
  it('accepts every settle status the endpoint enumerates', () => {
    for (const status of ['ok', 'error', 'rate_limited', 'budget_exceeded']) {
      expect(parseStatus(status)).toBe(status);
    }
  });

  it('reads anything else as no filter', () => {
    expect(parseStatus('cancelled')).toBeNull();
    expect(parseStatus(null)).toBeNull();
  });
});

describe('statusVariant', () => {
  it('separates success, hard errors and policy rejections', () => {
    expect(statusVariant('ok')).toBe('success');
    expect(statusVariant('error')).toBe('destructive');
    expect(statusVariant('rate_limited')).toBe('secondary');
    expect(statusVariant('budget_exceeded')).toBe('secondary');
  });
});

describe('mergeEvent', () => {
  const options = { filter: null, max: 3 };

  it('prepends, keeping newest first', () => {
    const merged = mergeEvent([event('a')], event('b'), options);
    expect(merged.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('drops a duplicate and returns the same array so React can skip the render', () => {
    const existing = [event('a')];
    expect(mergeEvent(existing, event('a'), options)).toBe(existing);
  });

  it('caps the list so a long-lived tab does not grow unbounded', () => {
    const merged = mergeEvent([event('c'), event('b'), event('a')], event('d'), options);
    expect(merged.map((e) => e.id)).toEqual(['d', 'c', 'b']);
  });

  it('applies the active filter, so live rows match the server-seeded ones', () => {
    const existing = [event('a', 'error')];
    expect(mergeEvent(existing, event('b', 'ok'), { filter: 'error', max: 3 })).toBe(existing);
    expect(mergeEvent(existing, event('c', 'error'), { filter: 'error', max: 3 })).toHaveLength(2);
  });
});
