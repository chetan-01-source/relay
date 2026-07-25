import { test, expect } from '@playwright/test';

/**
 * The PRD exit flow (Day 13): onboarding → build → operate, done entirely from the console with no
 * cURL. A non-author signs in, creates an application, issues a virtual key (copying the one-time
 * plaintext), grabs the snippet, and confirms the dashboard reflects the new resources.
 *
 * Requires an authenticated Logto session. Provide it as a saved storageState file via
 * RELAY_E2E_STORAGE_STATE (generate once with `playwright codegen` against a seeded Logto test user).
 * Without it the spec self-skips so CI without a test IdP still runs the gating specs.
 */
const storageState = process.env.RELAY_E2E_STORAGE_STATE;
test.skip(
  !storageState,
  'set RELAY_E2E_STORAGE_STATE (authenticated session) to run the build flow',
);
test.use({ storageState });

test('create app → issue key → snippet, all from the UI', async ({ page }) => {
  const appName = `e2e-${Date.now()}`;

  // Build: create an application.
  await page.goto('/apps');
  await page.getByLabel('Name').first().fill(appName);
  await page.getByRole('button', { name: 'Create application' }).click();
  await expect(page.getByText(appName)).toBeVisible();

  // Open it and issue a key.
  await page.getByRole('link', { name: 'Manage keys' }).last().click();
  await page.getByRole('button', { name: 'Create key' }).click();
  await page.getByRole('button', { name: 'Issue key' }).click();

  // Operate: the one-time key is revealed with a copy button and a snippet drawer.
  await expect(page.getByText('Copy your key now')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy key' })).toBeVisible();
  await page.getByRole('button', { name: 'cURL / SDK' }).click();
  await expect(page.getByText('/v1/chat/completions')).toBeVisible();
});
