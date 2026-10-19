/**
 * The zero-install demo stays usable without handing anyone a credential: an invitation goes to the
 * demo mailbox on the sign-in page, which the invited person opens signed out, and its link lets
 * them choose their own password.
 */
import { expect, test } from '@playwright/test';

test('TO-C1: in the zero-install demo, an invitation reaches the demo mailbox and its link works', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(baseURL!);
  await page.getByRole('button', { name: /Avery Stone/ }).click();
  await expect(page.locator('.topbar')).toContainText('Avery Stone');
  await page.evaluate(() => void (window.location.hash = '/admin'));
  await page.getByRole('button', { name: 'Invite' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite a person' });
  await invite.getByLabel('Email').fill('quinn.ward@bramblewood.example');
  await invite.getByLabel('Name').fill('Quinn Ward');
  await invite.getByRole('button', { name: 'Invite' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Invitation sent to quinn.ward@bramblewood.example (demo mailbox on the sign-in page)' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await page.getByRole('link', { name: 'demo mailbox' }).click();
  await page.getByRole('button', { name: 'Open the message to quinn.ward@bramblewood.example' }).click();
  await page.getByRole('region', { name: 'Message to quinn.ward@bramblewood.example' }).getByRole('link', { name: 'Open the link' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Quinn Ward' })).toBeVisible();
  await page.getByLabel(/^New password/).fill('quinn-codes-the-cards');
  await page.getByLabel('Repeat the new password').fill('quinn-codes-the-cards');
  await page.getByRole('button', { name: 'Save password' }).click();
  await page.getByRole('link', { name: 'Go to sign-in' }).click();
  await page.getByLabel('Email').fill('quinn.ward@bramblewood.example');
  await page.getByLabel('Password', { exact: true }).fill('quinn-codes-the-cards');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.topbar')).toContainText('Quinn Ward');
  expect(errors).toEqual([]);
});
