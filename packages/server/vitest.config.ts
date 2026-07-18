import { defineConfig } from 'vitest/config';

/**
 * Unit + integration tests. Coverage thresholds are enforced only under `pnpm coverage`
 * (the default `test` run stays fast and does not gate on coverage). Integration tests
 * self-skip when RELAY_TEST_DATABASE_URL is unset, so `pnpm turbo test` is CI-safe offline.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      // Unit-coverage targets BUSINESS LOGIC: adapters, services, repositories, queries, crypto.
      // HTTP boundaries (*.controller/*.routes), DI wiring (index.ts), and IO/bootstrap
      // (db pool, eventbus, logger, metrics, migrate, config, app, cli) are exercised by the
      // integration + smoke + e2e suites instead, not by unit coverage.
      include: [
        'src/modules/**/services/*.ts',
        'src/modules/**/repositories/*.ts',
        'src/modules/**/queries/*.ts',
        'src/modules/**/adapters/*.ts',
        'src/modules/**/lib/*.ts',
        'src/platform/crypto.ts',
      ],
      exclude: ['**/*.test.ts'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
