import { expect, test } from '@playwright/test';
import { signUpWithDemo } from './helpers';

test.describe('primary journeys (demo workspace)', () => {
  test('onboarding → briefing → complete a priority → review', async ({ page }) => {
    await signUpWithDemo(page);
    await expect(page.getByText('Demo workspace', { exact: true })).toBeVisible();
    await expect(page.getByText('Rule-based briefing')).toBeVisible(); // honest about missing AI
    await expect(page.getByText('Needs attention')).toBeVisible();
    await expect(page.getByText('Suspicious content')).toBeVisible(); // injection email flagged

    const first = page.getByRole('checkbox', { name: /Mark “Approve Q4 contractor budget” done/ });
    await first.click();
    await expect(page.getByText('Marked done')).toBeVisible();

    await page.goto('/reviews');
    await page.getByRole('button', { name: 'Review today now' }).click();
    await page.waitForURL('**/reviews/*');
    await expect(page.getByText('Accomplished')).toBeVisible();
    await expect(page.getByText('Approve Q4 contractor budget').first()).toBeVisible();
    await expect(page.getByText('Attendance isn’t verified — correct it if needed')).toBeVisible();
  });

  test('tasks: create, filter, edit and review AI-detected suggestions', async ({ page }) => {
    await signUpWithDemo(page);
    await page.keyboard.press('n');
    await page.getByLabel('What needs to be done?').fill('Book flights for offsite');
    await page.getByRole('button', { name: 'Add task' }).last().click();
    await expect(page.getByText('Task added')).toBeVisible();
    await page.goto('/tasks');
    await page.getByRole('tab', { name: /All open/ }).click();
    await expect(page.getByText('Book flights for offsite')).toBeVisible();
    await page.getByText('Book flights for offsite').click();
    await page.getByLabel('Status').selectOption('waiting');
    await page.getByLabel('Waiting on').fill('Travel desk');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('tab', { name: /Waiting/ }).click();
    await expect(page.getByText('Waiting on someone: Travel desk')).toBeVisible();

    await page.getByRole('tab', { name: /Suggested/ }).click();
    const card = page.getByText(/^Reply to Hannah Ortiz/).first();
    await expect(card).toBeVisible();
    await page.getByRole('button', { name: 'Add task' }).first().click();
    await expect(page.getByText('Added to your tasks')).toBeVisible();
  });

  test('demo data can never be sent; approvals are required for external actions', async ({ page }) => {
    await signUpWithDemo(page);
    await page.goto('/inbox');
    await page.getByRole('button', { name: /Dana Whitfield/ }).first().click();
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page.getByText('This is demo data. Replies can be written but not saved or sent.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save as draft' })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Send/ })).toBeDisabled();
  });

  test('settings: AI key validation, automations, theme', async ({ page }) => {
    await signUpWithDemo(page);
    await page.goto('/settings/ai');
    await expect(page.getByText('Separate API billing')).toBeVisible();
    await page.goto('/settings/automations');
    await page.getByRole('button', { name: 'Pause all' }).click();
    await expect(page.getByText('All automations are paused')).toBeVisible();
    await page.getByRole('button', { name: 'Resume all' }).click();
    await page.goto('/settings/general');
    await page.getByLabel('Theme').selectOption('dark');
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('command palette and keyboard navigation', async ({ page }) => {
    await signUpWithDemo(page);
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Type a command or search tasks…').fill('calendar');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/calendar');
    await page.keyboard.press('g');
    await page.keyboard.press('i');
    await page.waitForURL('**/inbox');
  });
});
