/**
 * Entity scope in the browser: the IT administrator limits a person's roles to the UK
 * subsidiary, and that person's screens follow (no consolidated view, UK data only).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const go = (page: Page, hash: string) => page.evaluate((h) => void (window.location.hash = h), hash);

async function signIn(page: Page, name: string) {
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.locator('.topbar')).toContainText(name);
}

async function setSamScope(page: Page, choose: (dialog: ReturnType<Page['getByRole']>) => Promise<void>) {
  await go(page, '/admin');
  const row = page.getByRole('row', { name: /Sam Rivera/ });
  await row.getByRole('button', { name: 'Roles' }).click();
  const dialog = page.getByRole('dialog', { name: 'Roles for Sam Rivera' });
  await expect(dialog).toBeVisible();
  await choose(dialog);
  await dialog.getByRole('button', { name: 'Save roles' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Roles updated for Sam Rivera' }).last()).toBeVisible();
  return row;
}

test('an administrator limits a person to one entity, and their screens follow', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto('/');
  await signIn(page, 'Avery Stone');

  const row = await setSamScope(page, async (dialog) => {
    await dialog.getByLabel('Only these entities').check();
    await dialog.getByLabel(/^BWL-US/).uncheck();
    await dialog.getByLabel(/^BWL-UK/).check();
    const axe = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  });
  await expect(row).toContainText('Only BWL-UK');
  await page.getByRole('button', { name: 'Sign out' }).click();

  await signIn(page, 'Sam Rivera');
  await go(page, '/reports');
  await expect(page.getByLabel('Scope').locator('option')).toHaveText([/^BWL-UK/]);
  await expect(page.locator('main')).not.toContainText('Something went wrong');
  for (const route of ['/home', '/close', '/inbox', '/journal']) {
    await go(page, route);
    await expect(page.locator('main h1').first()).toBeVisible();
    await expect(page.locator('main [role="alert"]')).toHaveCount(0);
  }
  await go(page, '/journal');
  await expect(page.locator('main')).toContainText('JE-2026-09-UK-');
  await expect(page.locator('main')).not.toContainText('-US-0');
  await page.getByRole('button', { name: 'Sign out' }).click();

  // give the access back so the rest of the suite sees the seeded roles
  await signIn(page, 'Avery Stone');
  const restored = await setSamScope(page, (dialog) => dialog.getByLabel('Every entity').check());
  await expect(restored).not.toContainText('Only BWL-UK');
  expect(problems).toEqual([]);
});
