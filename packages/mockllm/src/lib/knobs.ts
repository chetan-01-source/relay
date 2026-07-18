/**
 * Failure/latency knobs (playbook §6). These let the mock simulate the edge cases the gateway must
 * survive — latency tails, upstream errors, custom token counts — deterministically, no real provider.
 *
 * Env:    MOCKLLM_LATENCY_MS (default 40) · MOCKLLM_ERROR_RATE (0..1)
 * Header: x-mock-error=<status>  · x-mock-tokens=<n>
 */
export const LATENCY = Number(process.env.MOCKLLM_LATENCY_MS ?? 40);
export const ERROR_RATE = Number(process.env.MOCKLLM_ERROR_RATE ?? 0);

export const SAMPLE =
  'Hello from the mock upstream — this is a streamed completion, token by token.';

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Words to emit; `x-mock-tokens` header caps the count for token-accounting tests. */
export function words(limit?: number): string[] {
  const all = SAMPLE.split(' ');
  return limit && limit > 0 ? all.slice(0, limit) : all;
}

/** Parse a numeric header value, or undefined. */
export function numHeader(value: unknown): number | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;
}

/**
 * Decide whether this request should fail. An explicit `x-mock-error` header wins (returns that
 * status); otherwise MOCKLLM_ERROR_RATE applies. Returns the status to fail with, or null to proceed.
 */
export function shouldError(header: unknown): number | null {
  const forced = numHeader(header);
  if (forced) return forced;
  if (ERROR_RATE > 0 && Math.random() < ERROR_RATE) return 500;
  return null;
}
