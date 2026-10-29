import { expect, test } from '@playwright/test';
import { signUpWithDemo } from './helpers';

test('Today is usable without horizontal scrolling at this viewport', async ({ page }) => {
  await signUpWithDemo(page);
  for (const path of ['/', '/tasks', '/inbox', '/calendar', '/settings/integrations']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.getByText('Top priorities')).toBeVisible();
});
