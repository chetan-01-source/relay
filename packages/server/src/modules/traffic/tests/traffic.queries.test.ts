import { describe, it, expect } from 'vitest';
import { getByRequestIdQuery, listRecentQuery, listLogsQuery } from '../queries/traffic.queries.js';
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

describe('listLogsQuery', () => {
  const base = { limit: 50 };

  it('binds every filter as a parameter, never interpolating', () => {
    const hostile = "gpt'; DROP TABLE usage_events; --";
    const query = listLogsQuery({ ...base, search: hostile, model: hostile });
    expect(query.text).not.toContain('DROP TABLE');
    expect(query.values).toContain(hostile);
  });

  it('switches unused filters off with SQL null guards, keeping one fixed statement', () => {
    const query = listLogsQuery(base);
    expect(query.text).toContain('$1::text IS NULL OR status = $1');
    expect(query.text).toContain('$5::timestamptz IS NULL OR created_at >= $5');
    // All ten placeholders are always bound; only `limit` is set here.
    expect(query.values).toEqual([null, null, null, null, null, null, null, null, null, 50]);
  });

  /**
   * usage_events is append-heavy and RANGE partitioned. OFFSET would make Postgres walk and discard
   * every skipped row, and a row inserted mid-browse shifts the window so an event is shown twice
   * or missed. Comparing against the last row's (created_at, id) is stable and costs the same on
   * page 50 as on page 1.
   */
  it('pages by keyset, not OFFSET', () => {
    const query = listLogsQuery({
      ...base,
      beforeCreatedAt: '2026-08-15T08:31:25.731Z',
      beforeId: 'e6b68efd-6b95-4f8b-acae-6b9b392e4699',
    });
    expect(query.text).not.toContain('OFFSET');
    expect(query.text).toContain('(created_at, id) < ($8, $9::uuid)');
    expect(query.text).toContain('ORDER BY created_at DESC, id DESC');
  });

  it('searches request id or model, so a pasted trace id finds its request', () => {
    const query = listLogsQuery({ ...base, search: 'abc' });
    expect(query.text).toContain('request_id ILIKE');
    expect(query.text).toContain('model ILIKE');
  });

  it('treats the end of the window as exclusive', () => {
    // Half-open, so "to = end of day" needs no last-second-of-the-day arithmetic.
    expect(listLogsQuery({ ...base, to: '2026-08-16T00:00:00Z' }).text).toContain(
      'created_at < $6',
    );
  });

  it('always caps the page size', () => {
    expect(listLogsQuery(base).text).toContain('LIMIT $10');
  });
});
