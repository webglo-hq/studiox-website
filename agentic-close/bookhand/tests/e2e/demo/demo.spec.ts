import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { approveAllICan, axeViolations, closeDialogs, go, signInAs } from '../support';

/**
 * The zero-install demo: one static index.html, no backend and no network. The full application (domain,
 * agents, API kernel with auth and RBAC) runs in the page against the in-memory constraint engine.
 */

const DIST = join(process.cwd(), 'dist-demo');

test('the build is one self-contained file under 15 MB with relative paths only', () => {
  const files = readdirSync(DIST);
  expect(files).toEqual(['index.html']);
  const size = statSync(join(DIST, 'index.html')).size;
  expect(size).toBeLessThan(15 * 1024 * 1024);
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  expect(html).toMatch(/<title>Bookhand Close<\/title>/);
  expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)="\/(?!\/)/);
  expect(html).not.toMatch(/serviceWorker\.register/);
  expect(html).not.toContain('__VITE_PRELOAD__');
});

test('boots offline, runs the agents and takes decisions without any network request', async ({ page, baseURL }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    const url = r.url();
    if (!url.startsWith(baseURL!) && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page).toHaveTitle('Bookhand Close');
  await expect(page.getByRole('heading', { name: 'Sign in to close the books' })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Running entirely in your browser')).toBeVisible();

  await signInAs(page, 'maya');
  await expect(page.getByText('Zero-install demo.')).toBeVisible();
  await expect(page.getByText('Offline agents').first()).toBeVisible();
  await page.getByRole('button', { name: 'Run close agents' }).first().click();
  await expect(page.getByRole('heading', { name: 'Close orchestrator' })).toBeVisible();
  await expect(page.locator('.page-head').getByText('Completed')).toBeVisible({ timeout: 180_000 });

  // A senior accountant rejects one item with a reason, then approves the rest that are within the limit.
  await signInAs(page, 'daniel');
  await go(page, '#/inbox');
  await page.getByRole('button', { name: /Investigate unexplained bank debit/ }).first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Why the agent proposes this')).toBeVisible();
  await drawer.getByRole('button', { name: 'Reject' }).click();
  const reason = page.getByRole('dialog', { name: 'Reject proposal' });
  await reason.getByRole('textbox').fill('Bank confirmed the debit is a card fee; booking it manually.');
  await reason.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Rejected.' }).first()).toBeVisible();
  expect(await approveAllICan(page)).toBeGreaterThan(0);

  // Keyboard shortcuts, then undo-by-reversal of an agent-posted entry (the Controller's limit covers it).
  await page.keyboard.press('g');
  await page.keyboard.press('l');
  await expect(page.getByRole('heading', { name: 'Journal entries', level: 1 })).toBeVisible();
  await signInAs(page, 'hannah');
  await go(page, '#/ledger?source=agent&status=posted');
  await expect(page.getByRole('heading', { name: 'Journal entries', level: 1 })).toBeVisible();
  await page.locator('table tbody tr').first().click();
  const entry = page.getByRole('dialog');
  await expect(entry.getByText('Ontology checks')).toBeVisible();
  await entry.getByRole('button', { name: 'Reverse (undo)' }).click();
  const why = page.getByRole('dialog', { name: 'Reverse this entry' });
  await why.getByRole('textbox').fill('Duplicate of an entry already booked by the ERP export.');
  await why.getByRole('button', { name: 'Post reversal' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Reversal .* posted\./ }).first()).toBeVisible();
  await expect(entry.getByText('Reversed by')).toBeVisible();
  await closeDialogs(page);

  // Theme switch works without storage access errors.
  await page.getByRole('button', { name: /Switch to dark theme/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  expect(external, 'the demo must not touch the network').toEqual([]);
  expect(errors).toEqual([]);
});

test('works at phone width without horizontal scrolling and passes WCAG 2.2 AA checks', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to close the books' })).toBeVisible({ timeout: 120_000 });
  expect(await axeViolations(page)).toEqual([]);
  await signInAs(page, 'hannah');
  for (const hash of ['#/', '#/inbox', '#/close', '#/recs', '#/ledger', '#/reports', '#/skills/transaction-coding', '#/ontology/bh:Accrual']) {
    await go(page, hash);
    await page.waitForTimeout(400);
    await expect(page.locator('main')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${hash} scrolls horizontally`).toBeLessThanOrEqual(0);
  }
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Inbox' })).toBeVisible();
});

test('runs inside a sandboxed iframe with an opaque origin (no storage, no same-origin access)', async ({ page, baseURL }) => {
  await page.setContent(`<!doctype html><title>host</title><iframe title="Bookhand demo" sandbox="allow-scripts" src="${baseURL}/" style="width:1300px;height:860px;border:0"></iframe>`);
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: 'Sign in to close the books' })).toBeVisible({ timeout: 120_000 });
  await frame.getByRole('button', { name: /Sign in as Maya Chen/ }).click();
  await expect(frame.getByRole('heading', { name: /Good (morning|afternoon|evening), Maya/ })).toBeVisible();
  await frame.getByRole('link', { name: 'Reconciliations' }).click();
  await expect(frame.getByRole('heading', { name: 'Reconciliations', level: 1 })).toBeVisible();
});
