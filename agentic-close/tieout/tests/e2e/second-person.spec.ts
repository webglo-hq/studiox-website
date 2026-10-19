/**
 * Nobody mints an approver alone, in the browser: the IT administrator invites a CFO and never
 * sees a password or link; the role waits under Access requests, where the administrator cannot
 * approve their own request and the CFO can. The new CFO sets her own password from the demo
 * mailbox. (Adds Nora Bell, whom no later suite needs.)
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const go = (page: Page, hash: string) => page.evaluate((h) => void (window.location.hash = h), hash);
const serious = async (page: Page) => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);

async function signIn(page: Page, name: string) {
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.locator('.topbar')).toContainText(name);
}

test('TO-C1: an invited CFO holds no authority until a second person with the authority approves it', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto('/');
  await signIn(page, 'Avery Stone');
  await go(page, '/admin');
  await page.getByRole('button', { name: 'Invite' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite a person' });
  await invite.getByLabel('Email').fill('nora.bell@bramblewood.example');
  await invite.getByLabel('Name').fill('Nora Bell');
  await invite.getByLabel('Role').selectOption({ label: 'CFO' });
  await invite.getByRole('button', { name: 'Invite' }).click();
  const toast = page.locator('.toast').filter({ hasText: 'Invitation sent to nora.bell@bramblewood.example' }).last();
  await expect(toast).toContainText(/Nora Bell: CFO for every entity waits for a second person to approve it \(AR-\d{4}/);
  const nora = page.getByRole('row', { name: /Nora Bell/ });
  await expect(nora).toContainText('Invited');
  await expect(nora.locator('.badge').filter({ hasText: 'CFO' })).toHaveCount(0);

  // the requester sees the request but cannot decide it
  await page.getByRole('button', { name: /^Access requests/ }).click();
  const request = page.getByRole('row', { name: /Nora Bell: CFO/ });
  await expect(request).toContainText('You asked for this change, so someone else has to decide it.');
  await expect(request.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  expect(await serious(page)).toEqual([]);
  await page.getByRole('button', { name: 'Sign out' }).click();

  // the CFO approves it
  await signIn(page, 'Riley Chen');
  await go(page, '/admin?tab=access');
  await request.getByRole('button', { name: /^Approve AR-/ }).click();
  const approve = page.getByRole('dialog', { name: /^Approve AR-/ });
  await approve.getByLabel(/Note for the audit log/).fill('Board appointment confirmed');
  await approve.getByRole('button', { name: 'Approve and apply' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'It applies now' }).last()).toBeVisible();
  await expect(request).toContainText('Approved');
  await expect(request).toContainText('by Riley Chen: Board appointment confirmed');
  await page.getByRole('button', { name: 'Sign out' }).click();

  // Nora chooses her own password from the demo mailbox, and signs in as CFO
  await go(page, '/mailbox');
  await page.getByRole('button', { name: 'Open the message to nora.bell@bramblewood.example' }).first().click();
  await page.getByRole('region', { name: 'Message to nora.bell@bramblewood.example' }).getByRole('link', { name: 'Open the link' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Nora Bell' })).toBeVisible();
  await page.getByLabel(/^New password/).fill('nora-signs-off-the-close');
  await page.getByLabel('Repeat the new password').fill('nora-signs-off-the-close');
  await page.getByRole('button', { name: 'Save password' }).click();
  await page.getByRole('link', { name: 'Go to sign-in' }).click();
  await page.getByLabel('Email').fill('nora.bell@bramblewood.example');
  await page.getByLabel('Password', { exact: true }).fill('nora-signs-off-the-close');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.topbar')).toContainText('Nora Bell');
  await expect(page.locator('.topbar')).toContainText('CFO');
  expect(problems).toEqual([]);
});
