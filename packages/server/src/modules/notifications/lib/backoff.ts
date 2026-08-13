/**
 * Retry schedule — PURE, so the escalation is unit-tested without waiting for it.
 *
 * A failed send is usually transient (SMTP timeout, greylisting, a provider blip), so retries are
 * worth it. They are capped and exponential because the alternative — a tight retry on a permanently
 * misconfigured channel — turns one bad tenant config into a self-inflicted mail flood.
 */

/** Attempts before a notification is marked `failed` and stops being retried. */
export const MAX_ATTEMPTS = 5;

/** Seconds to wait before attempt `n` (1-based), capped so a stuck row retries hourly, not never. */
export function backoffSeconds(attempt: number): number {
  const capped = Math.min(Math.max(attempt, 1), 10);
  // 1m, 5m, 25m, then flat at 1h.
  return Math.min(60 * 5 ** (capped - 1), 3600);
}

/** True once a notification has burned its last attempt. */
export function isDead(attempt: number): boolean {
  return attempt >= MAX_ATTEMPTS;
}
