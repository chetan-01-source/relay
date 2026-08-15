/**
 * Budget view model — PURE, so the period maths and threshold logic are unit-tested without a
 * gateway.
 *
 * A budget on its own is just a number; what an operator needs is "how much of it have I used, in
 * the period it applies to". The gateway enforces the ceiling against a Valkey counter on the hot
 * path, but for *display* the console derives spend from the usage rollups — the same source the
 * Usage & spend report uses, so the two screens can never disagree.
 */
import type { BudgetPeriod } from './api';
import type { UsageWindow } from './analytics';

export const BUDGET_PERIODS: readonly BudgetPeriod[] = ['daily', 'monthly'];

/** Copy for each period, so the page doesn't scatter string literals. */
export const PERIOD_LABEL: Record<string, string> = {
  daily: 'Daily',
  monthly: 'Monthly',
};

/** ISO date (YYYY-MM-DD) in UTC — rollups are keyed in UTC, so the window must be too. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The inclusive window of the period `today` falls in: the day itself, or the calendar month to
 * date. `today` is a parameter so this stays pure and the test doesn't depend on the clock.
 *
 * The window starts at the period boundary, not "the last 30 days" — a monthly budget resets on the
 * 1st, and showing a rolling window would report spend the ceiling is no longer counting.
 */
export function periodWindow(period: BudgetPeriod, today: Date): UsageWindow {
  const to = isoDate(today);
  if (period === 'daily') return { from: to, to };
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  return { from: isoDate(start), to };
}

export interface BudgetStatus {
  /** Spend as a percentage of the ceiling, clamped to 0–100 for the bar's width. */
  percent: number;
  /** The true ratio, uncapped — an over-budget org should be able to see how far over. */
  ratio: number;
  tone: 'ok' | 'warn' | 'over';
  remainingUsd: number;
}

/** Where this period's spend sits against the ceiling. */
export function budgetStatus(spentUsd: number, limitUsd: number): BudgetStatus {
  // A zero or invalid ceiling can't be divided by; report it as unused rather than NaN%.
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
    return { percent: 0, ratio: 0, tone: 'ok', remainingUsd: 0 };
  }
  const spent = Number.isFinite(spentUsd) ? Math.max(0, spentUsd) : 0;
  const ratio = spent / limitUsd;
  return {
    percent: Math.min(100, Math.round(ratio * 100)),
    ratio,
    // 80% is the point worth warning at: enough runway to act before requests start failing.
    tone: ratio >= 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok',
    remainingUsd: Math.max(0, limitUsd - spent),
  };
}

/**
 * Find the ceiling for one scope+period, or null when none is set. Generic so the caller keeps the
 * full element type — narrowing to the constraint would hide `limit_usd` from the page.
 *
 * `appId` null means the ORG-wide ceiling. The scope has to be part of the lookup: matching on
 * period alone would return an application's ceiling when asked for the org's, and show a limit on
 * the wrong card.
 */
export function budgetFor<T extends { period?: string; app_id?: string | null }>(
  budgets: readonly T[],
  period: BudgetPeriod,
  appId: string | null = null,
): T | null {
  return budgets.find((b) => b.period === period && (b.app_id ?? null) === appId) ?? null;
}

/** True when any ceiling is scoped to this application. */
export function hasAppBudget(
  budgets: readonly { app_id?: string | null }[],
  appId: string,
): boolean {
  return budgets.some((b) => b.app_id === appId);
}

/**
 * What actually happens at the ceiling, in one sentence — the difference between `hard_cutoff` true
 * and false is the difference between "requests fail" and "nothing happens", and a checkbox label
 * alone does not carry that.
 */
export function enforcementSummary(hardCutoff: boolean): string {
  return hardCutoff
    ? 'Requests are rejected with budget_exceeded once the ceiling is reached.'
    : 'Spend is tracked and reported, but requests are never blocked.';
}

/** The gateway stores `limit_usd` as `numeric(12,4)`. */
const LIMIT_SCALE = 4;
const MIN_LIMIT_USD = 0.0001;

/**
 * Why this limit cannot be stored as typed, or `null` when it is fine.
 *
 * The gateway is the authority and re-checks independently; this exists so the two failures a user
 * can actually hit come back instantly and say what to do. The second one is not cosmetic: a value
 * under 0.0001 rounds to 0 in the column, and a zero budget with hard cutoff blocks every request
 * the organization makes.
 */
export function limitScaleError(limitUsd: number): string | null {
  if (limitUsd < MIN_LIMIT_USD) {
    return `The smallest limit is ${MIN_LIMIT_USD}. Anything less is stored as 0, which would block every request.`;
  }
  // toPrecision(15) first, because most decimals are inexact as binary doubles: 1.0001 * 1e4 is
  // 10001.000000000002, and a bare integer check would reject a value that stores perfectly.
  const scaled = Number((limitUsd * 10 ** LIMIT_SCALE).toPrecision(15));
  if (!Number.isInteger(scaled)) {
    return `Limits support at most ${LIMIT_SCALE} decimal places.`;
  }
  return null;
}
