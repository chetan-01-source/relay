import { describe, it, expect } from 'vitest';
import { computeHealthScore, percentile } from '../lib/health.js';

describe('percentile', () => {
  it('is nearest-rank and handles the empty set', () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([10, 20, 30, 40, 50], 0.95)).toBe(50);
    expect(percentile([10, 20, 30, 40, 50], 0.5)).toBe(30);
  });
});

describe('computeHealthScore', () => {
  it('treats an empty window as fully healthy (new targets are not penalized)', () => {
    expect(computeHealthScore([])).toEqual({ errorRate: 0, p95Ms: 0, score: 1 });
  });

  it('scores 1 - errorRate and reports p95 latency', () => {
    const samples = [
      { ok: true, latencyMs: 100 },
      { ok: true, latencyMs: 200 },
      { ok: false, latencyMs: 300 },
      { ok: true, latencyMs: 400 },
    ];
    const health = computeHealthScore(samples);
    expect(health.errorRate).toBe(0.25);
    expect(health.score).toBe(0.75);
    expect(health.p95Ms).toBe(400);
  });

  it('clamps to [0,1] when everything fails', () => {
    expect(computeHealthScore([{ ok: false, latencyMs: 5 }]).score).toBe(0);
  });
});
