/**
 * Two-factor authentication in the browser: set it up (codes from the real TOTP algorithm),
 * save the recovery codes, sign in with one when the authenticator is "lost", and have the IT
 * administrator reset it. Leaves the CFO as seeded (no two-factor) for the suites after it.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { totpAt, TOTP_PERIOD } from '../../src/core/auth/totp';

const go = (page: Page, hash: string) => page.evaluate((h) => void (window.location.hash = h), hash);

async function signIn(page: Page, name: string) {
  await page.getByRole('button', { name: new RegExp(name) }).click();
}

test('two-factor: set up, recovery codes, lost authenticator, administrator reset', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto('/');
  await signIn(page, 'Riley Chen');
  await expect(page.locator('.topbar')).toContainText('Riley Chen');

  // set up with the authenticator's current code (wall-clock time, like a phone)
  await go(page, '/admin?tab=account');
  await page.getByRole('button', { name: 'Set up' }).click();
  const secret = (await page.getByLabel('Setup key').innerText()).replace(/\s/g, '');
  await page.getByLabel('Code').fill(totpAt(secret, Math.floor(Date.now() / 1000 / TOTP_PERIOD)));
  await page.getByRole('button', { name: 'Turn on' }).click();
  const list = page.getByRole('list', { name: 'Recovery codes' });
  await expect(list.locator('li')).toHaveCount(10);
  const codes = await list.locator('li').allInnerTexts();
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  await page.getByRole('button', { name: 'Sign out' }).click();

  // the authenticator is lost: a recovery code signs in once
  await signIn(page, 'Riley Chen');
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();
  await page.getByRole('button', { name: 'Lost your authenticator? Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(codes[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.locator('.topbar')).toContainText('Riley Chen');
  await go(page, '/admin?tab=account');
  await expect(page.getByText('9 unused recovery codes')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();

  // the IT administrator resets it after checking who is asking
  await signIn(page, 'Avery Stone');
  await expect(page.locator('.topbar')).toContainText('Avery Stone');
  await go(page, '/admin');
  await page.getByRole('row', { name: /Riley Chen/ }).getByRole('button', { name: 'Sign-in' }).click();
  await page.getByRole('dialog', { name: 'Sign-in help for Riley Chen' }).getByRole('button', { name: 'Reset two-factor' }).click();
  const reason = page.getByRole('dialog', { name: 'Reset two-factor for Riley Chen?' });
  await reason.getByRole('textbox').fill('Lost phone; identity confirmed on a video call');
  await reason.getByRole('button', { name: 'Reset two-factor' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Two-factor authentication reset for Riley Chen' }).last()).toBeVisible();
  await expect(page.getByRole('row', { name: /Riley Chen/ })).toContainText('Off');
  await page.getByRole('button', { name: 'Sign out' }).click();

  await signIn(page, 'Riley Chen');
  await expect(page.locator('.topbar')).toContainText('Riley Chen');
  await page.getByRole('button', { name: 'Sign out' }).click();
  expect(problems).toEqual([]);
});
