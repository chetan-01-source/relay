import { describe, it, expect } from 'vitest';
import { traceSummary, worstStatus } from './trace';
import type { TrafficEvent } from './api';

const event = (over: Partial<TrafficEvent>): TrafficEvent => ({
  id: 'e1',
  status: 'ok',
  created_at: '2026-08-09T15:00:00Z',
  input_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
  ...over,
});

describe('traceSummary', () => {
  it('orders events oldest-first so the page reads as a timeline', () => {
    const summary = traceSummary([
      event({ id: 'b', created_at: '2026-08-09T15:00:02Z' }),
      event({ id: 'a', created_at: '2026-08-09T15:00:01Z' }),
    ]);
    expect(summary.ordered.map((e) => e.id)).toEqual(['a', 'b']);
    expect(summary.startedAt).toBe('2026-08-09T15:00:01Z');
  });

  it('sums tokens and cost across every settle event of the request', () => {
    const summary = traceSummary([
      event({ input_tokens: 15, output_tokens: 7, cost_usd: 0.000006 }),
      event({ id: 'e2', input_tokens: 5, output_tokens: 2, cost_usd: 0.000002 }),
    ]);
    expect(summary.inputTokens).toBe(20);
    expect(summary.outputTokens).toBe(9);
    expect(summary.costUsd).toBeCloseTo(0.000008, 9);
    expect(summary.events).toBe(2);
  });

  it('takes the MAX latency, not the sum — overlapping events would overstate the wait', () => {
    const summary = traceSummary([
      event({ latency_ms: 1409 }),
      event({ id: 'e2', latency_ms: 670 }),
    ]);
    expect(summary.latencyMs).toBe(1409);
  });

  it('reports null latency when no event recorded one', () => {
    expect(traceSummary([event({})]).latencyMs).toBeNull();
  });

  it('surfaces a failure even when a later event succeeded', () => {
    // A retry that eventually worked still contains a failure worth seeing in the header.
    const summary = traceSummary([
      event({ status: 'error', created_at: '2026-08-09T15:00:01Z' }),
      event({ id: 'e2', status: 'ok', created_at: '2026-08-09T15:00:02Z' }),
    ]);
    expect(summary.status).toBe('error');
  });

  it('handles an empty trace without throwing', () => {
    const summary = traceSummary([]);
    expect(summary).toMatchObject({ events: 0, costUsd: 0, status: 'ok', startedAt: '' });
  });
});

describe('worstStatus', () => {
  it('ranks a hard error above policy rejections', () => {
    expect(worstStatus(['ok', 'rate_limited', 'error'])).toBe('error');
    expect(worstStatus(['ok', 'rate_limited', 'budget_exceeded'])).toBe('budget_exceeded');
  });

  it('is ok only when everything settled cleanly', () => {
    expect(worstStatus(['ok', 'ok'])).toBe('ok');
    expect(worstStatus([])).toBe('ok');
  });

  it('surfaces an unrecognised status rather than hiding it behind ok', () => {
    expect(worstStatus(['ok', 'cancelled'])).toBe('cancelled');
  });
});
