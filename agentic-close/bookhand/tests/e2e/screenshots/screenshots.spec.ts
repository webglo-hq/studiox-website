import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { closeRound, go, signInAs, waitForAgents } from '../support';

/**
 * Product screenshots for the README and docs: desktop 1440x900 and phone 390x844 (device pixels equal CSS
 * pixels). The run follows the demo script on a freshly seeded server: agents run, people review, the close is
 * driven to the flux review, the package and the lock, and the auditor verifies the chain.
 */

const OUT = join(process.cwd(), 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });

test.describe.configure({ mode: 'serial' });

async function shot(page: Page, name: string): Promise<void> {
  // Notifications from earlier steps are not part of the screen being shown.
  const dismiss = page.locator('.toasts').getByRole('button', { name: 'Dismiss' });
  while ((await dismiss.count()) > 0) await dismiss.first().click();
  await page.waitForTimeout(350);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

let closeId = '';

test('desktop: agents prepare, people review', async ({ page }) => {
  test.setTimeout(10 * 60_000);
  await page.goto('/landing.html');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, 'desktop-15-landing');
  await page.evaluate(() => document.getElementById('pricing')?.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await shot(page, 'desktop-16-landing-pricing');

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to close the books' })).toBeVisible();
  await shot(page, 'desktop-01-sign-in');

  // Running the close agents keeps Maya on My close, which then offers the review (B-7); the trace is one click away.
  await signInAs(page, 'maya');
  await page.getByRole('button', { name: 'Run close agents' }).first().click();
  await expect(page.getByRole('heading', { name: /^Close agents (are working|finished)$/ })).toBeVisible();
  await waitForAgents(page);
  await expect(page.getByRole('link', { name: /^Review \d+ items?$/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: "What's next for you" })).toBeVisible();
  await shot(page, 'desktop-02-my-close');

  await page.getByRole('link', { name: 'Open the agent trace' }).click();
  await expect(page.getByRole('heading', { name: 'Close orchestrator' })).toBeVisible();
  await expect(page.locator('.page-head').getByText('Completed')).toBeVisible();
  await shot(page, 'desktop-06-agent-run-trace');

  await signInAs(page, 'daniel');
  const close = (await (await page.request.get('/api/closes/current')).json()) as { close: { id: string } };
  closeId = close.close.id;
  await go(page, `#/close/${closeId}`);
  await expect(page.getByRole('list', { name: 'Close calendar by workday' })).toBeVisible();
  await shot(page, 'desktop-03-close-cockpit');

  await go(page, '#/inbox');
  await page.getByRole('button', { name: /HALCYON FREIGHT/ }).first().click();
  await expect(page.getByRole('dialog').getByText('Why the agent proposes this')).toBeVisible();
  await shot(page, 'desktop-04-inbox-injection-flagged');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  const recs = (await (await page.request.get('/api/recs')).json()) as { recs: Array<{ id: string | null; type: string | null; entity: string; account: string }> };
  const bank = recs.recs.find((r) => r.id && r.type === 'bank' && r.entity === 'BW-US' && r.account.startsWith('1000'));
  expect(bank?.id).toBeTruthy();
  await go(page, `#/recs/${bank!.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, 'desktop-05-bank-rec-workbench');

  await go(page, '#/reports?view=bs');
  await expect(page.getByText('Total assets').first()).toBeVisible();
  await shot(page, 'desktop-08-statements');

  await go(page, '#/ledger?source=agent');
  await page.locator('table tbody tr').first().click();
  await expect(page.getByRole('dialog').getByText('Ontology checks')).toBeVisible();
  await shot(page, 'desktop-07-journal-entry');
  await page.keyboard.press('Escape');

  await signInAs(page, 'hannah');
  await go(page, '#/skills/transaction-coding');
  await page.getByLabel('Rules, one per line').fill('Always code Figma to 6420\nNever auto-post anything over $5,000\nRequire approval for Apple Store');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('Ready to publish.')).toBeVisible();
  await shot(page, 'desktop-09-skill-policy');

  await go(page, '#/ontology/bh:DepositInTransit');
  await expect(page.getByRole('heading', { name: 'Deposit in transit' })).toBeVisible();
  await shot(page, 'desktop-10-ontology');
});

test('phone', async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: 'light', baseURL: test.info().project.use.baseURL });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to close the books' })).toBeVisible();
  await shot(page, 'phone-01-sign-in');
  await signInAs(page, 'daniel');
  await expect(page.getByRole('heading', { name: "What's next for you" })).toBeVisible();
  await shot(page, 'phone-02-my-close');
  await go(page, '#/inbox');
  await expect(page.locator('table.inbox-table')).toBeVisible();
  await shot(page, 'phone-03-inbox');
  await page.getByRole('button', { name: /HALCYON FREIGHT/ }).first().click();
  await expect(page.getByRole('dialog').getByText('Why the agent proposes this')).toBeVisible();
  await shot(page, 'phone-04-proposal');
  await page.keyboard.press('Escape');
  await go(page, '#/close');
  await expect(page.getByRole('list', { name: 'Close calendar by workday' })).toBeVisible();
  await shot(page, 'phone-05-cockpit');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await shot(page, 'phone-06-navigation');
  await page.goto('/landing.html');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, 'phone-07-landing');
  await context.close();
});

test('desktop: flux, package, lock, audit', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  await page.goto('/');
  await signInAs(page, 'daniel');

  // Drive the close until the Controller can approve the flux analysis, and capture it before approving.
  let fluxShot = false;
  for (let round = 0; round < 8 && !fluxShot; round++) {
    await closeRound(page, { approveFlux: false });
    await signInAs(page, 'hannah');
    await go(page, '#/flux');
    await expect(page.getByRole('heading', { name: 'Flux review', level: 1 })).toBeVisible();
    if (await page.getByRole('button', { name: 'Approve analysis' }).isVisible()) {
      await shot(page, 'desktop-11-flux');
      fluxShot = true;
    }
  }
  expect(fluxShot, 'the flux analysis reached the Controller').toBe(true);

  for (let round = 0; round < 8; round++) {
    const r = await closeRound(page);
    if (r.complete) break;
  }
  await signInAs(page, 'hannah');
  await go(page, `#/close/${closeId}/package`);
  await expect(page.getByText('Final').first()).toBeVisible();
  await shot(page, 'desktop-13-close-package');

  await go(page, `#/close/${closeId}`);
  await expect(page.getByText('Everything is signed off.')).toBeVisible();
  await page.getByRole('button', { name: 'Lock period' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Comment for the audit log (optional)').fill('September close complete');
  await dialog.getByRole('button', { name: 'Lock period' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Period locked/ }).first()).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByRole('status').filter({ hasText: /^Period locked/ })).toHaveCount(0, { timeout: 15_000 });
  await shot(page, 'desktop-14-cockpit-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await signInAs(page, 'sofia');
  await go(page, '#/audit');
  await page.getByRole('button', { name: 'Verify the chain' }).click();
  await expect(page.getByText('Chain intact.')).toBeVisible();
  await shot(page, 'desktop-12-audit-log');
});
