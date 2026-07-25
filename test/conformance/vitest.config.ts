import { defineConfig } from 'vitest/config';

/**
 * Conformance runs against a REAL running gateway (→ mockllm), not fakes — so it is a separate
 * project from the unit suites and is never part of `make test`. It self-skips unless
 * RELAY_CONFORMANCE_BASE_URL + RELAY_CONFORMANCE_KEY point at a live stack (see conformance.yml).
 * A generous timeout covers the SDK's own retry/backoff on the first cold request.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.conformance.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
