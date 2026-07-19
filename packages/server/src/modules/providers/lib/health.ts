/**
 * Provider health scoring (Week 2 Day 8 · stub for the Day-9 router). Pure functions over a rolling
 * window of request outcomes: a health score in [0,1] driven by the error rate, plus the p95 latency
 * the router uses as a tie-breaker. No IO, no state — the caller owns the window; the router later
 * persists the score into provider_credentials.health_score and prefers healthier, faster targets.
 */
export interface HealthSample {
  ok: boolean; // did the upstream call succeed?
  latencyMs: number; // wall-clock of that call
}

export interface HealthScore {
  errorRate: number; // fraction of failed calls in the window [0,1]
  p95Ms: number; // 95th-percentile latency
  score: number; // 1 - errorRate, clamped to [0,1]; a fresh/empty window is fully healthy (1)
}

/** Nearest-rank p-percentile of the values (0 for an empty set). p is a fraction, e.g. 0.95. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length); // 1-based nearest-rank
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

/** Score a window of samples. An empty window is treated as healthy so new targets aren't penalized. */
export function computeHealthScore(samples: HealthSample[]): HealthScore {
  if (samples.length === 0) return { errorRate: 0, p95Ms: 0, score: 1 };
  const failures = samples.filter((s) => !s.ok).length;
  const errorRate = failures / samples.length;
  return {
    errorRate,
    p95Ms: percentile(
      samples.map((s) => s.latencyMs),
      0.95,
    ),
    score: Math.min(1, Math.max(0, 1 - errorRate)),
  };
}
