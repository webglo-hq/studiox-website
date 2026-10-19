/**
 * A forgotten password in the browser: the IT administrator sends a reset link and never sees it;
 * the link waits in the demo mailbox, which opens a message only in a signed-out browser; the
 * person chooses their own password with it. (Uses Devon Park, whom no later suite needs.)
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const go = (page: Page, hash: string) => page.evaluate((h) => void (window.location.hash = h), hash);
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const serious = async (page: Page) => (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);

test('TO-C1: a forgotten password is reset with a link that only the person opens', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto('/');
  await page.getByRole('button', { name: /Avery Stone/ }).click();
  await expect(page.locator('.topbar')).toContainText('Avery Stone');
  await go(page, '/admin');
  await page.getByRole('row', { name: /Devon Park/ }).getByRole('button', { name: 'Sign-in' }).click();
  await page.getByRole('dialog', { name: 'Sign-in help for Devon Park' }).getByRole('button', { name: 'Send a password-reset link' }).click();
  // the administrator learns where the link went, and nothing that would let them use it
  await expect(page.locator('.toasts')).toContainText('was sent to devon@bramblewood.example (demo mailbox on the sign-in page)');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // the mailbox does not open for a signed-in administrator
  await go(page, '/mailbox');
  await expect(page.getByRole('heading', { name: 'Demo mailbox' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'You are signed in as Avery Stone' })).toBeVisible();
  const open = page.getByRole('button', { name: 'Open the message to devon@bramblewood.example' }).first();
  await expect(open).toBeDisabled();
  await page.getByRole('button', { name: 'Sign out' }).click();

  // signed out, Devon reads the message and follows the link
  await expect(open).toBeEnabled();
  expect(await serious(page)).toEqual([]);
  await open.click();
  const message = page.getByRole('region', { name: 'Message to devon@bramblewood.example' });
  await expect(message).toContainText('Avery Stone reset your Tieout password');
  await message.getByRole('link', { name: 'Open the link' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await expect(page.locator('main')).toContainText('devon@bramblewood.example');
  expect(await serious(page)).toEqual([]);
  await page.getByLabel(/^New password/).fill('devon-explains-the-variances');
  await page.getByLabel('Repeat the new password').fill('devon-explains-the-variances');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('heading', { name: 'Your password is set' })).toBeVisible();
  await page.getByRole('link', { name: 'Go to sign-in' }).click();

  await page.getByLabel('Email').fill('devon@bramblewood.example');
  await page.getByLabel('Password', { exact: true }).fill('devon-explains-the-variances');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.topbar')).toContainText('Devon Park');
  await go(page, '/home');
  await expect(page.getByRole('heading', { level: 1, name: /Welcome back, Devon/ })).toBeVisible();
  expect(problems).toEqual([]);
});
