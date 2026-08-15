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

/** `count` days before `date`, in UTC. */
function daysBefore(date: string, count: number): string {
  const earlier = new Date(`${date}T00:00:00Z`);
  earlier.setUTCDate(earlier.getUTCDate() - count);
  return earlier.toISOString().slice(0, 10);
}

/** The later of two ISO dates — they sort lexicographically, so a plain comparison is correct. */
function laterOf(a: string, b: string): string {
  return a > b ? a : b;
}

/** The next calendar day, in UTC. `YYYY-MM-DD` in, `YYYY-MM-DD` out. */
function nextDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * Shape `group_by=day` buckets into a date-ascending series for the spend chart.
 *
 * The API returns a bucket only for days that HAD usage, so plotting them directly draws the 10th
 * and the 15th side by side and the four silent days in between vanish. The x-axis then lies: bar
 * width stops meaning "a day" and a quiet week looks identical to a busy one. Every day in the
 * window is emitted, with zeros where nothing was spent.
 *
 * `window` is the range the user actually asked for. Without it the series can only span the days
 * that returned data, so a window ending in silence would still stop at the last busy day — which
 * is exactly the gap being fixed. Pure — unit-tested.
 */
export function toDailySeries(
  summary: UsageSummary | null | undefined,
  limit = 30,
  window?: { from: string; to: string },
): DailyPoint[] {
  const byDate = new Map<string, DailyPoint>();
  for (const bucket of summary?.data ?? []) {
    const date = bucket.key ?? '';
    if (!date) continue;
    byDate.set(date, {
      date,
      cost: bucket.cost_usd ?? 0,
      requests: bucket.requests ?? 0,
    });
  }

  const dates = [...byDate.keys()].sort();
  const first = window?.from ?? dates[0];
  const last = window?.to ?? dates[dates.length - 1];
  if (!first || !last || first > last) return [];

  // Start at the later of the window's beginning and `limit` days back from its end. That bounds
  // the loop by construction — a decade-wide window costs `limit` iterations, not 3,650 — and it
  // keeps the RECENT days, which a trailing slice off a truncated loop would not.
  const start = laterOf(first, daysBefore(last, limit - 1));

  const series: DailyPoint[] = [];
  for (let date = start; date <= last; date = nextDay(date)) {
    series.push(byDate.get(date) ?? { date, cost: 0, requests: 0 });
  }
  return series;
}
