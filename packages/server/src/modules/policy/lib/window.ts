/**
 * Budget period windows — PURE, so the counter's identity and lifetime are unit-tested without
 * Valkey.
 *
 * This exists because of a real defect. The budget counter used to be keyed `budget:{org}:{period}`
 * with `period` as the literal word `daily`/`monthly` — no calendar window at all — and both Lua
 * scripts end in `SET … EX ttl`, which REFRESHES the expiry on every reserve and settle. The key
 * therefore only expired after a full TTL of complete silence, so any org with regular traffic
 * accumulated spend forever: a "daily" budget would trip once and stay tripped.
 *
 * Stamping the calendar window into the key fixes it by construction. `…:daily:2026-08-10` is a
 * different key from `…:daily:2026-08-09`, so the new period starts at zero whether or not the old
 * key expired. The TTL becomes a cleanup mechanism rather than the reset mechanism.
 *
 * Windows are UTC. That is a deliberate choice, and it matches how the usage rollups are already
 * bucketed (`date_trunc('day', hour)` on UTC-keyed hours) — so what the console reports and what the
 * gateway enforces describe the same day.
 */

export type BudgetPeriod = 'daily' | 'monthly';

/** Grace on top of the window so a late settle still lands on the counter it reserved against. */
const SETTLE_GRACE_SECONDS = 60 * 60; // 1h

export interface BudgetWindow {
  /** Identifies the calendar window; part of the counter key. */
  stamp: string;
  /** Seconds until the window closes, plus settle grace. Always ≥ 1 so SET EX stays valid. */
  ttlSeconds: number;
  /** ISO timestamp the window opened at — the lower bound for seeding a cold counter. */
  startsAt: string;
}

/** The UTC calendar window `now` falls in: `YYYY-MM-DD` for daily, `YYYY-MM` for monthly. */
export function budgetWindow(period: BudgetPeriod, now: Date): BudgetWindow {
  const iso = now.toISOString();
  const stamp = period === 'daily' ? iso.slice(0, 10) : iso.slice(0, 7);
  const endsAt = period === 'daily' ? nextUtcDay(now) : nextUtcMonth(now);
  const startsAt = period === 'daily' ? startOfUtcDay(now) : startOfUtcMonth(now);
  const remainingMs = endsAt.getTime() - now.getTime();
  return {
    stamp,
    ttlSeconds: Math.max(1, Math.ceil(remainingMs / 1000) + SETTLE_GRACE_SECONDS),
    startsAt: startsAt.toISOString(),
  };
}

/**
 * The Valkey key for one ceiling. The scope segment separates an application's counter from the
 * org-wide one, so a request spends against both independently rather than double-counting into one.
 */
export function budgetKey(
  orgId: string,
  appId: string | null,
  period: BudgetPeriod,
  stamp: string,
): string {
  return `budget:${orgId}:${appId ?? 'org'}:${period}:${stamp}`;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

function nextUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
}

function nextUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}
