/**
 * Dashboard aggregation (Day 13) — PURE, so it is unit-testable without a running gateway. Turns the
 * analytics `usage` buckets (already grouped + summed server-side) into the headline totals the
 * overview tiles render. Only derives what the analytics endpoint actually exposes (spend, requests,
 * tokens) — cache-savings / error-rate would need data the rollups don't carry, so they are not faked.
 */
import type { UsageSummary } from './api';

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  topKey: string | null; // the highest-spend bucket key (model/app/day), or null when empty
}

export function summarizeUsage(summary: UsageSummary | null | undefined): UsageTotals {
  const data = summary?.data ?? [];
  const totals: UsageTotals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    topKey: null,
  };
  let topCost = -1;
  for (const bucket of data) {
    totals.requests += bucket.requests ?? 0;
    totals.inputTokens += bucket.input_tokens ?? 0;
    totals.outputTokens += bucket.output_tokens ?? 0;
    totals.costUsd += bucket.cost_usd ?? 0;
    if ((bucket.cost_usd ?? 0) > topCost) {
      topCost = bucket.cost_usd ?? 0;
      totals.topKey = bucket.key ?? null;
    }
  }
  return totals;
}

/** Format a USD amount for a tile (always 4 dp so sub-cent spend is visible). */
export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}
