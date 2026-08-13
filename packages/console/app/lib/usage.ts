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

/**
 * Format a USD amount, scaling precision to the magnitude.
 *
 * A fixed 4 dp is wrong for this product: a short gpt-4o-mini call costs ~$0.000006, so real spend
 * rendered as "$0.0000" and read as "usage isn't being tracked". Small amounts therefore get the
 * full 6 dp the rollups actually store (`cost_usd numeric(14,6)`), while larger ones stay readable
 * — nobody wants to read "$1234.560000".
 *
 * 6 dp is the floor because it is the storage precision; a positive amount that would still round to
 * zero there is shown as a "less than" rather than a bare $0.00, so "tiny" never reads as "none".
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '$0.00';

  const sign = value < 0 ? '-' : '';
  const amount = Math.abs(value);

  if (amount >= 1) return `${sign}$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `${sign}$${amount.toFixed(4)}`;
  if (amount < 0.0000005) return `${sign}<$0.000001`;
  return `${sign}$${amount.toFixed(6)}`;
}

export interface DailyPoint {
  date: string; // YYYY-MM-DD (the group_by=day bucket key)
  cost: number;
  requests: number;
}

export interface OrgUsageRow {
  orgId: string;
  name: string; // resolved org name, or the raw id when unknown
  requests: number;
  costUsd: number;
}

/** Turn the platform cross-org usage summary (buckets keyed by org_id) into named, cost-descending
 * rows for the admin table. `names` maps org_id → display name; unknown ids fall back to the id.
 * Pure — unit-tested. */
export function labelOrgUsage(
  summary: UsageSummary | null | undefined,
  names: Map<string, string>,
): OrgUsageRow[] {
  return (summary?.data ?? [])
    .map((b) => {
      const orgId = b.key ?? '(none)';
      return {
        orgId,
        name: names.get(orgId) ?? orgId,
        requests: b.requests ?? 0,
        costUsd: b.cost_usd ?? 0,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);
}

/** Shape `group_by=day` buckets into a date-ascending series for the spend chart, keeping the most
 * recent `limit` days. Pure — unit-tested. */
export function toDailySeries(summary: UsageSummary | null | undefined, limit = 30): DailyPoint[] {
  const points = (summary?.data ?? []).map((b) => ({
    date: b.key ?? '',
    cost: b.cost_usd ?? 0,
    requests: b.requests ?? 0,
  }));
  points.sort((a, b) => a.date.localeCompare(b.date)); // ISO dates sort lexicographically
  return points.slice(-limit);
}
