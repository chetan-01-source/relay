import { describe, it, expect } from 'vitest';
import { isRelayError } from '@relay/shared';
import { parseGroupBy, parseWindow, parseFormat, toCsv } from '../lib/usage-format.js';
import type { UsageBucket } from '../types/analytics.types.js';

describe('parseGroupBy', () => {
  it('defaults to model when omitted', () => {
    expect(parseGroupBy(undefined)).toBe('model');
  });

  it('accepts each allowlisted value', () => {
    expect(parseGroupBy('app')).toBe('app');
    expect(parseGroupBy('route')).toBe('route');
    expect(parseGroupBy('model')).toBe('model');
    expect(parseGroupBy('day')).toBe('day');
  });

  it('rejects anything off the allowlist with a 400 invalid_request', () => {
    try {
      parseGroupBy('org_id; DROP TABLE usage_rollups_hourly');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isRelayError(err) && err.code).toBe('invalid_request');
      expect(isRelayError(err) && err.status).toBe(400);
      expect(isRelayError(err) && err.param).toBe('group_by');
    }
  });
});

describe('parseFormat', () => {
  it('defaults to json and accepts json/csv', () => {
    expect(parseFormat(undefined)).toBe('json');
    expect(parseFormat('json')).toBe('json');
    expect(parseFormat('csv')).toBe('csv');
  });

  it('rejects an unknown format', () => {
    expect(() => parseFormat('xml')).toThrow();
  });
});

describe('parseWindow', () => {
  it('passes through valid ISO timestamps', () => {
    expect(parseWindow({ from: '2026-07-01T00:00:00Z', to: '2026-07-24T00:00:00Z' })).toEqual({
      from: '2026-07-01T00:00:00Z',
      to: '2026-07-24T00:00:00Z',
    });
  });

  it('is empty when neither bound is given', () => {
    expect(parseWindow({})).toEqual({});
  });

  it('rejects a malformed timestamp (fails loud, not silently ignored)', () => {
    try {
      parseWindow({ from: 'last-tuesday' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isRelayError(err) && err.code).toBe('invalid_request');
      expect(isRelayError(err) && err.param).toBe('from');
    }
  });
});

describe('toCsv', () => {
  const rows: UsageBucket[] = [
    { key: 'gpt-4o', requests: 3, input_tokens: 100, output_tokens: 50, cost_usd: 0.0123 },
  ];

  it('emits a header and a fixed-6dp cost', () => {
    const csv = toCsv(rows);
    expect(csv.split('\n')[0]).toBe('key,requests,input_tokens,output_tokens,cost_usd');
    expect(csv).toContain('"gpt-4o",3,100,50,0.012300');
  });

  it('quotes fields and doubles embedded quotes (injection/format safe)', () => {
    const csv = toCsv([
      { key: 'weird",id', requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    ]);
    expect(csv).toContain('"weird"",id"');
  });

  it('renders a header-only body for an empty result', () => {
    expect(toCsv([])).toBe('key,requests,input_tokens,output_tokens,cost_usd\n');
  });
});
