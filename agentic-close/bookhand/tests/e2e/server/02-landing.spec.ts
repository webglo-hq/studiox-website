import { expect, test } from '@playwright/test';
import { axeViolations } from '../support';

/** The public landing page: content, pricing tiers, accessibility, phone layout and the way into the product. */
test('the landing page explains the product, shows the tiers and leads to the demo', async ({ page }) => {
  await page.goto('/landing.html');
  await expect(page).toHaveTitle('Bookhand Agentic Close');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your close, prepared by agents. Approved by people.');
  const tiers = page.locator('#pricing article');
  await expect(tiers).toHaveCount(3);
  await expect(tiers.getByRole('heading', { level: 3 })).toHaveText(['Team', 'Growth', 'Enterprise']);
  // B-10: the page claims only what the product does: single sign-on is planned, and the approval controls are
  // described as built (launchers never approve their run's output; nobody grants themselves authority).
  await expect(tiers.nth(2).getByRole('listitem').filter({ hasText: 'Single sign-on' })).toContainText('planned');
  const controls = page.locator('#controls');
  await expect(controls).toContainText('started the agent run behind it');
  await expect(controls).toContainText('Nobody grants themselves power');
  await expect(controls).not.toContainText('Nobody approves their own journal, reconciliation, flux explanation or task');
  expect(await axeViolations(page)).toEqual([]);

  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await axeViolations(page)).toEqual([]);
  await page.emulateMedia({ colorScheme: 'light' });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.getByRole('link', { name: 'Open the demo' }).first().click();
  await expect(page.getByRole('heading', { name: 'Sign in to close the books' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('link', { name: /What is Bookhand\? Product and pricing/ })).toBeVisible();
});
