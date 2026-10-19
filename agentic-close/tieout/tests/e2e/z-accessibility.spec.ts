/**
 * Automated WCAG 2.2 AA checks (axe-core) on every screen, in light and dark mode, plus the
 * open proposal drawer and the sign-in page. Runs after the demo script so screens hold data.
 * Automated checks catch a subset of issues; keyboard and screen-reader passes are manual.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ROUTES = ['/home', '/close', '/inbox', '/recs', '/flux', '/journal', '/reports', '/reports?view=tb', '/runs', '/skills', '/skills/bank-reconciliation', '/ontology', '/ontology?view=axioms', '/audit', '/admin', '/admin?tab=account', '/imports'];

async function violations(page: Page, label: string): Promise<string[]> {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

test('sign-in page and every screen pass axe (WCAG 2.2 AA) in light and dark mode', async ({ page }) => {
  test.setTimeout(240_000);
  const found: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    found.push(...(await violations(page, `${scheme} /login`)));
    await page.getByRole('button', { name: /Riley Chen/ }).click();
    await expect(page.locator('.topbar')).toContainText('Riley Chen');
    for (const route of ROUTES) {
      await page.evaluate((h) => void (window.location.hash = h), route);
      await expect(page.locator('main h1').first()).toBeVisible();
      await page.waitForTimeout(250);
      found.push(...(await violations(page, `${scheme} ${route}`)));
    }
    await page.evaluate(() => void (window.location.hash = '/inbox'));
    const first = page.locator('.prop a.title').first();
    if (await first.count()) {
      await first.click();
      await expect(page.locator('.drawer')).toBeVisible();
      found.push(...(await violations(page, `${scheme} proposal drawer`)));
      await page.keyboard.press('Escape');
    }
    await page.getByRole('button', { name: 'Sign out' }).click();
  }
  expect(found).toEqual([]);
});

test('keyboard: skip link, focus trap in dialogs, Escape closes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Casey Morgan/ }).click();
  await expect(page.locator('.topbar')).toContainText('Casey Morgan');
  await page.evaluate(() => void (window.location.hash = '/home'));
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
  expect(await help.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
});
