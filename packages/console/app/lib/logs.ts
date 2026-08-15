/**
 * Log view model — PURE, so the status mapping is unit-tested without a gateway.
 */

/**
 * Badge tone for a request status.
 *
 * `rate_limited` and `budget_exceeded` are deliberately NOT destructive: the gateway did exactly
 * what it was configured to do, and colouring a working ceiling the same red as an upstream failure
 * trains operators to ignore the colour. They warn; only `error` is a fault.
 */
export function statusTone(
  status: string | null | undefined,
): 'success' | 'secondary' | 'destructive' {
  if (status === 'ok') return 'success';
  if (status === 'error') return 'destructive';
  return 'secondary';
}
