import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E (Day 13). Runs against a RUNNING console (`make dev` brings up the gateway on :3000
 * and the console on :3100). The gating specs need no auth; the full build→operate flow needs an
 * authenticated Logto session supplied via RELAY_E2E_STORAGE_STATE (a saved storageState file) and
 * self-skips otherwise, so CI without a test IdP still runs the security gates.
 */
const baseURL = process.env.RELAY_E2E_BASE_URL ?? 'http://localhost:3100';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
