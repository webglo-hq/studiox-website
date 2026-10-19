/**
 * A forgotten password in the browser: the IT administrator issues a temporary password, and the
 * person has to choose their own before anything else. (Uses Devon Park, whom no later suite needs.)
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const go = (page: Page, hash: string) => page.evaluate((h) => void (window.location.hash = h), hash);

test('a temporary password is replaced at the first sign-in', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto('/');
  await page.getByRole('button', { name: /Avery Stone/ }).click();
  await expect(page.locator('.topbar')).toContainText('Avery Stone');
  await go(page, '/admin');
  await page.getByRole('row', { name: /Devon Park/ }).getByRole('button', { name: 'Sign-in' }).click();
  await page.getByRole('dialog', { name: 'Sign-in help for Devon Park' }).getByRole('button', { name: 'Issue a temporary password' }).click();
  const shown = page.getByRole('dialog', { name: 'Temporary password for Devon Park' });
  await expect(shown).toBeVisible();
  const temp = (await shown.locator('.mono').innerText()).trim();
  expect(temp.length).toBeGreaterThanOrEqual(24);
  await shown.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await page.getByLabel('Email').fill('devon@bramblewood.example');
  await page.getByLabel('Password', { exact: true }).fill(temp);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  await expect(page.getByLabel('Temporary password')).toHaveValue(temp);
  await page.getByLabel(/^New password/).fill('devon-explains-the-variances');
  await page.getByLabel('Repeat the new password').fill('devon-explains-the-variances');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.locator('.topbar')).toContainText('Devon Park');
  await go(page, '/home');
  await expect(page.getByRole('heading', { level: 1, name: /Welcome back, Devon/ })).toBeVisible();
  expect(problems).toEqual([]);
});
