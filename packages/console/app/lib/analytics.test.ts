import { describe, it, expect } from 'vitest';
import {
  parseGrouping,
  parseDate,
  defaultWindow,
  groupingColumn,
  exportHref,
  apiWindow,
  DEFAULT_GROUPING,
} from './analytics';

describe('parseGrouping', () => {
  it('accepts every grouping the gateway supports', () => {
    for (const value of ['app', 'route', 'model', 'day']) {
      expect(parseGrouping(value)).toBe(value);
    }
  });

  it('falls back for anything unsupported, so a hand-edited URL cannot 400 the page', () => {
    expect(parseGrouping('org')).toBe(DEFAULT_GROUPING);
    expect(parseGrouping(null)).toBe(DEFAULT_GROUPING);
    expect(parseGrouping(undefined)).toBe(DEFAULT_GROUPING);
  });
});

describe('parseDate', () => {
  it('passes through an ISO date', () => {
    expect(parseDate('2026-03-04', '2026-01-01')).toBe('2026-03-04');
  });

  it('rejects anything not YYYY-MM-DD rather than forwarding it to the gateway', () => {
    expect(parseDate('4 March', '2026-01-01')).toBe('2026-01-01');
    expect(parseDate('2026-3-4', '2026-01-01')).toBe('2026-01-01');
    expect(parseDate(null, '2026-01-01')).toBe('2026-01-01');
  });
});

describe('defaultWindow', () => {
  it('is the trailing 30 days, inclusive of today', () => {
    expect(defaultWindow(new Date('2026-03-30T12:00:00Z'))).toEqual({
      from: '2026-03-01',
      to: '2026-03-30',
    });
  });

  it('crosses a month boundary', () => {
    expect(defaultWindow(new Date('2026-01-05T00:00:00Z'), 10)).toEqual({
      from: '2025-12-27',
      to: '2026-01-05',
    });
  });
});

describe('apiWindow', () => {
  // Regression: the endpoint filters `hour < $to::timestamptz`, and a bare date coerces to midnight.
  // Sending the picker's inclusive end verbatim dropped the whole final day — so a report covering
  // "up to today" showed $0 while Live traffic showed the very same requests.
  it('advances the inclusive end to the exclusive bound the endpoint wants', () => {
    expect(apiWindow({ from: '2026-07-11', to: '2026-08-09' })).toEqual({
      from: '2026-07-11',
      to: '2026-08-10',
    });
  });

  it('leaves the start untouched — it is already inclusive on both sides', () => {
    expect(apiWindow({ from: '2026-08-09', to: '2026-08-09' }).from).toBe('2026-08-09');
  });

  it('rolls over month and year boundaries', () => {
    expect(apiWindow({ from: '2026-01-01', to: '2026-01-31' }).to).toBe('2026-02-01');
    expect(apiWindow({ from: '2026-12-01', to: '2026-12-31' }).to).toBe('2027-01-01');
  });

  it('handles a leap day', () => {
    expect(apiWindow({ from: '2028-02-01', to: '2028-02-28' }).to).toBe('2028-02-29');
    expect(apiWindow({ from: '2028-02-01', to: '2028-02-29' }).to).toBe('2028-03-01');
  });

  it('covers the same day the default window ends on', () => {
    // The end-to-end guarantee: a request made at any hour today falls inside the default report.
    const today = new Date('2026-08-09T15:00:00Z');
    const { to } = apiWindow(defaultWindow(today));
    expect(new Date('2026-08-09T15:00:00Z') < new Date(`${to}T00:00:00Z`)).toBe(true);
  });
});

describe('groupingColumn', () => {
  it('labels the bucket-key column per grouping', () => {
    expect(groupingColumn('day')).toBe('Date');
    expect(groupingColumn('app')).toBe('Application');
  });
});

describe('exportHref', () => {
  it('builds the org CSV link with the full query', () => {
    expect(exportHref('org', { group_by: 'model', from: '2026-01-01', to: '2026-01-31' })).toBe(
      '/api/analytics/export?scope=org&group_by=model&from=2026-01-01&to=2026-01-31',
    );
  });

  it('omits absent params', () => {
    expect(exportHref('platform', {})).toBe('/api/analytics/export?scope=platform');
  });
});
