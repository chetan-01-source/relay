import { defineConfig } from 'vitest/config';

/**
 * Vitest runs the pure unit tests only (`*.test.ts` co-located under app/lib). The Playwright E2E
 * specs live in test/e2e/*.spec.ts and are driven by `pnpm e2e` (playwright), never by vitest —
 * excluded here so the two runners don't collide.
 */
export default defineConfig({
  test: {
    include: ['app/**/*.test.ts'],
    exclude: ['test/e2e/**', 'node_modules/**', '.next/**'],
  },
});
