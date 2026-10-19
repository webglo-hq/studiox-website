import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { addPersonAndEnrol, approveAllICan, axeViolations, closeDialogs, go, signInAs } from '../support';

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
  await expect(page.getByRole('link', { name: /^Review \d+ items?$/ })).toBeVisible({ timeout: 180_000 });

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

test('B-7, B-2, B-3: run the agents from My close, review in bulk with a confirmation, open the focused proposal with Enter', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to close the books' })).toBeVisible({ timeout: 120_000 });
  await signInAs(page, 'maya');

  // B-7: starting the agents keeps you on My close, which then offers the next step.
  await page.getByRole('button', { name: 'Run close agents' }).first().click();
  await expect(page.getByRole('heading', { name: /^Close agents (are working|finished)$/ })).toBeVisible();
  expect(await page.evaluate(() => window.location.hash)).not.toContain('/runs/');
  const review = page.getByRole('link', { name: /^Review \d+ items?$/ });
  await expect(review).toBeVisible({ timeout: 180_000 });
  await review.click();
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();

  // B-2: "Select all" leaves out flagged and low-confidence items; approving asks for confirmation with the count and total.
  await signInAs(page, 'daniel');
  await go(page, '#/inbox');
  await expect(page.locator('table.inbox-table')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select all' }).check();
  await expect(page.getByRole('checkbox', { name: /^Select Match .*HALCYON FREIGHT/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /^Select Investigate unexplained bank debit/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /^Select Accrue Fieldnote Research/ })).toBeChecked();
  const approve = page.getByRole('button', { name: /^Approve \d+$/ });
  const count = Number((await approve.innerText()).match(/\d+/)?.[0] ?? '0');
  expect(count).toBeGreaterThan(0);
  await approve.click();
  const confirm = page.getByRole('dialog', { name: `Approve ${count} ${count === 1 ? 'item' : 'items'}?` });
  await expect(confirm.getByTestId('bulk-summary')).toContainText(`${count} ${count === 1 ? 'item' : 'items'}`);
  await expect(confirm.getByTestId('bulk-summary')).toContainText(/\$[\d,]+\.\d\d at stake/);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear' }).click();

  // B-3: Enter activates the control that has focus. Focus the second proposal, move the shortcut cursor two
  // rows on with "j", then press Enter: the focused proposal opens, not the cursor row.
  const titles = page.locator('table.inbox-table tbody tr td .link-button');
  const second = titles.nth(1);
  const wanted = (await second.innerText()).trim();
  await second.focus();
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByRole('heading', { level: 2 }).first()).toHaveText(wanted);
  await closeDialogs(page);

  // B-1: the balance sheet shows current-year earnings inside equity and foots.
  await go(page, '#/reports?view=bs');
  const bs = page.getByRole('region', { name: /Consolidated balance sheet/ });
  await expect(bs.getByRole('cell', { name: 'Current-year earnings' })).toBeVisible();
  await expect(bs.getByRole('cell', { name: 'Total liabilities and equity' })).toBeVisible();
  await expect(bs.getByTestId('bs-footing')).toHaveText('Foots: assets = liabilities + equity');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('BH-C1: an admin adds a person who enrols from their own delivery log; the role waits for the Controller', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to close the books' })).toBeVisible({ timeout: 120_000 });
  await signInAs(page, 'tom');
  await addPersonAndEnrol(page, { name: 'Rosa Field', email: 'rosa.field@brambleway.example', role: 'Senior Accountant', password: 'quiet-harbour-lantern-42' });
  await expect(page.getByText('You have no roles yet')).toBeVisible();
  await signInAs(page, 'hannah');
  await page.getByRole('link', { name: /Decide 1 access request/ }).click();
  await page.getByRole('listitem').filter({ hasText: 'Grant Senior Accountant to Rosa Field' }).getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Approved: Grant Senior Accountant to Rosa Field/ })).toBeVisible();
});

test('works at phone width without horizontal scrolling and passes WCAG 2.2 AA checks', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to close the books' })).toBeVisible({ timeout: 120_000 });
  expect(await axeViolations(page)).toEqual([]);
  await signInAs(page, 'hannah');
  for (const hash of ['#/', '#/inbox', '#/close', '#/recs', '#/ledger', '#/reports', '#/skills/transaction-coding', '#/ontology/bh:Accrual', '#/settings']) {
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

test('every screen passes WCAG 2.2 AA checks in light and dark themes', async ({ page }) => {
  test.setTimeout(8 * 60_000);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to close the books' })).toBeVisible({ timeout: 120_000 });
  await signInAs(page, 'maya');
  await page.getByRole('button', { name: 'Run close agents' }).first().click();
  await expect(page.getByRole('link', { name: /^Review \d+ items?$/ })).toBeVisible({ timeout: 180_000 });
  await page.getByRole('link', { name: 'Open the agent trace' }).click();
  await expect(page.locator('.page-head').getByText('Completed')).toBeVisible();
  const runHash = await page.evaluate(() => window.location.hash);
  await signInAs(page, 'hannah');
  type Check = (p: Page) => Promise<unknown>;
  const screens: Array<{ hash: string; ready: Check; open?: Check }> = [
    { hash: '#/', ready: (p) => expect(p.getByRole('heading', { name: "What's next for you" })).toBeVisible() },
    { hash: '#/close', ready: (p) => expect(p.getByRole('list', { name: 'Close calendar by workday' })).toBeVisible() },
    { hash: '#/inbox', ready: (p) => expect(p.locator('table.inbox-table')).toBeVisible(), open: (p) => p.getByRole('button', { name: /HALCYON FREIGHT/ }).first().click() },
    { hash: '#/recs', ready: (p) => expect(p.getByRole('heading', { name: 'Reconciliations', level: 1 })).toBeVisible() },
    { hash: '#/flux', ready: (p) => expect(p.getByRole('heading', { name: 'Flux review', level: 1 })).toBeVisible() },
    { hash: '#/ledger', ready: (p) => expect(p.getByRole('heading', { name: 'Journal entries', level: 1 })).toBeVisible(), open: (p) => p.locator('table tbody tr').first().click() },
    { hash: '#/reports', ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible() },
    { hash: '#/imports', ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible() },
    { hash: '#/runs', ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible() },
    { hash: runHash, ready: (p) => expect(p.getByRole('heading', { name: 'Close orchestrator' })).toBeVisible() },
    { hash: '#/skills', ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible() },
    { hash: '#/skills/transaction-coding', ready: (p) => expect(p.getByLabel('Rules, one per line')).toBeVisible() },
    { hash: '#/ontology/bh:DepositInTransit', ready: (p) => expect(p.getByRole('heading', { name: 'Deposit in transit' })).toBeVisible() },
    { hash: '#/audit', ready: (p) => expect(p.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible() },
    { hash: '#/settings', ready: (p) => expect(p.getByRole('heading', { name: 'Your settings', level: 1 })).toBeVisible() },
  ];
  const problems: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const s of screens) {
      await closeDialogs(page);
      await go(page, s.hash);
      await s.ready(page);
      await page.waitForTimeout(250);
      for (const v of await axeViolations(page)) problems.push(`${theme} ${s.hash}: ${v}`);
      if (s.open) {
        await s.open(page);
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.waitForTimeout(250);
        for (const v of await axeViolations(page)) problems.push(`${theme} ${s.hash} (drawer): ${v}`);
      }
    }
  }
  await closeDialogs(page);
  await signInAs(page, 'tom');
  await go(page, '#/admin');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  for (const v of await axeViolations(page)) problems.push(`dark #/admin: ${v}`);
  expect(problems).toEqual([]);
});
