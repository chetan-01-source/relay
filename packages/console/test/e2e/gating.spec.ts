import { test, expect } from '@playwright/test';

/**
 * Server-side authorization gate (PRD constraint: "scope checks server-side, not just hidden in UI").
 * An unauthenticated visitor is redirected off every console page back to the landing page — the
 * protected content is never served. Needs only the console running (no Logto session).
 */
const PROTECTED = ['/dashboard', '/apps', '/providers', '/audit'];

test('landing page renders the console entry point', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Relay Console', { exact: true })).toBeVisible();
});

for (const path of PROTECTED) {
  test(`unauthenticated ${path} is redirected to the landing page`, async ({ page }) => {
    await page.goto(path);
    // requireUser() redirects to '/' server-side, so the protected page never renders.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('Relay Console', { exact: true })).toBeVisible();
  });
}
