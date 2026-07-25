import { describe, it, expect } from 'vitest';
import { getByRequestIdQuery, listRecentQuery } from '../queries/traffic.queries.js';
import { trafficChannel } from '../types/traffic.types.js';

describe('traffic queries — parametrized, never interpolated', () => {
  it('lists recent with only the limit bound when no status filter', () => {
    const q = listRecentQuery({ limit: 50 });
    expect(q.values).toEqual([50]);
    expect(q.text).toContain('ORDER BY created_at DESC LIMIT $1');
    expect(q.text).not.toContain('WHERE status');
  });

  it('binds status ($1) then limit ($2) when filtered — status is a value, not text', () => {
    const q = listRecentQuery({ limit: 25, status: 'error' });
    expect(q.values).toEqual(['error', 25]);
    expect(q.text).toContain('WHERE status = $1');
    expect(q.text).not.toContain('error'); // never interpolated
  });

  it('casts cost_usd to text so the numeric survives JSON without float drift', () => {
    expect(listRecentQuery({ limit: 1 }).text).toContain('cost_usd::text AS cost_usd');
  });

  it('getByRequestId binds the trace id and orders oldest-first', () => {
    const q = getByRequestIdQuery('trace-1');
    expect(q.values).toEqual(['trace-1']);
    expect(q.text).toContain('ORDER BY created_at ASC');
  });
});

describe('trafficChannel', () => {
  it('is per-org so one org never receives another org’s live feed', () => {
    expect(trafficChannel('org-a')).toBe('relay:traffic:org-a');
    expect(trafficChannel('org-a')).not.toBe(trafficChannel('org-b'));
  });
});
