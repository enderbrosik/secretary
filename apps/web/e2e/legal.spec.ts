import { expect, test } from '@playwright/test';

test('privacy policy and terms are public pages', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();
  await expect(page.getByText('including the Limited Use requirements')).toBeVisible();
  await page.getByRole('link', { name: 'Terms of Service' }).click();
  await expect(page).toHaveURL(/\/terms$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Terms of Service' })).toBeVisible();
  await page.goto('/signup');
  await expect(page.getByText('By creating an account you agree to the')).toBeVisible();
});
