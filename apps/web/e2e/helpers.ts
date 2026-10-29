import { expect, type Page } from '@playwright/test';

/** Creates an account and completes onboarding with the demo workspace (no external credentials needed). */
export async function signUpWithDemo(page: Page) {
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Alex Rivera');
  await page.getByLabel('Email').fill(`e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/onboarding');
  const next = () => page.getByRole('button', { name: /^Continue/ }).click();
  await next(); // welcome
  await next(); // provider choice
  await page.getByRole('button', { name: 'Skip for now' }).click(); // no API key in CI
  await page.getByRole('button', { name: 'Load sample data' }).click();
  await expect(page.getByRole('button', { name: 'Sync now' })).toBeVisible({ timeout: 20_000 });
  await next(); // accounts
  await next(); // permissions
  await next(); // schedule
  await next(); // style
  await page.getByRole('button', { name: 'Prepare my briefing' }).click();
  await page.waitForURL((u) => u.pathname === '/');
  await expect(page.getByText('Top priorities')).toBeVisible();
}
