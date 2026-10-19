/**
 * The demo script, end to end in a real browser (also run against the zero-install static demo).
 * One page for the whole story; navigation is in-app (hash routes) so the static demo's in-memory
 * state survives between steps.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

let page: Page;
const problems: string[] = [];
const go = (hash: string) => page.evaluate((h) => void (window.location.hash = h), hash);
const toast = (text: string | RegExp) => page.locator('.toast').filter({ hasText: text }).last();
const openFirst = async () => {
  await page.locator('.prop a.title').first().click();
  return page.locator('.drawer');
};

test.beforeAll(async ({ browser, baseURL }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 401/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  await page.goto(baseURL!);
});

test.afterAll(async () => {
  await page.close();
});

test('1 · sign in as the Senior Accountant of the fictional company', async () => {
  await expect(page.getByText('Bramblewood Labs is a fictional company')).toBeVisible();
  await page.getByRole('button', { name: /Jordan Lee/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome back, Jordan.' })).toBeVisible();
  await expect(page.getByText(/agents haven.t run for September 2026 yet/)).toBeVisible();
  await expect(page.locator('.period-chip')).toContainText('WD+2');
});

test('2 · run the close agents: nine checklist tasks in dependency waves', async () => {
  await page.getByRole('button', { name: /Run close agents/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Close agents finished' });
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await expect(dialog).toContainText('9 of 9 checklist tasks ran in 3 dependency waves');
  await expect(dialog).toContainText('Proposed 4 accruals totalling $561,381.00 for BWL-US');
  await dialog.getByRole('link', { name: 'Review the inbox' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
});

test('3 · the planted prompt injection in a bank memo is withheld and held for a person', async () => {
  await go('/inbox?q=Riverside');
  const row = page.locator('.prop').filter({ hasText: 'RIVERSIDE AGRICO' });
  await expect(row).toContainText('Instruction-like text');
  await expect(row).toContainText('[withheld]');
  await expect(row).not.toContainText(/IGNORE PRIOR RULES|AUTO-APPROVE/);
  await expect(row).toContainText('Needs approval');
});

test('4 · segregation of duties: whoever ran the agents cannot approve their output', async () => {
  await go('/inbox?q=Accrue Cumulus');
  const drawer = await openFirst();
  await expect(drawer).toContainText('Accrue Cumulus Hosting Co.');
  await expect(drawer).toContainText('You can’t approve this.');
  await expect(drawer).toContainText('You ran the agent that prepared this');
  await drawer.getByRole('button', { name: 'Close' }).click();
});

test('5 · the Controller approves the accrual; it posts with why, evidence and an approval trail', async () => {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: /Casey Morgan/ }).click();
  // signing in keeps you on the screen you were on (deep links survive a session change)
  await expect(page.locator('.topbar')).toContainText('Casey Morgan');
  await go('/inbox?q=Accrue Cumulus');
  const drawer = await openFirst();
  await expect(drawer.getByRole('heading', { name: 'Evidence' })).toBeVisible();
  await expect(drawer).toContainText('Verification');
  await drawer.getByRole('button', { name: /Approve & post/ }).click();
  await expect(toast(/approved and applied/)).toBeVisible();

  await go('/journal?q=Cumulus');
  await page.locator('table.data a.row-link').filter({ hasText: /^JE-/ }).first().click();
  await expect(page.locator('main')).toContainText('Approved by');
  await expect(page.locator('main')).toContainText('Casey Morgan');
  await expect(page.locator('main')).toContainText(/Posted/);
});

test('6 · approval limits route the payroll accrual to the CFO', async () => {
  await go('/inbox?q=payroll days');
  const row = page.locator('.prop').filter({ hasText: 'Accrue 13 unpaid payroll days' });
  await expect(row).toContainText('for CFO');
  await expect(row).toContainText(/approval limit/);
});

test('7 · bank reconciliation workbench ties statement to ledger', async () => {
  await go('/recs');
  await expect(page.getByRole('heading', { level: 1, name: 'Reconciliations' })).toBeVisible();
  await page.getByRole('row').filter({ hasText: 'First Harbor' }).getByRole('link', { name: 'Open workbench' }).click();
  await expect(page.getByRole('heading', { name: 'Tie-out' })).toBeVisible();
  await expect(page.locator('main')).toContainText('Balance per bank statement');
  await expect(page.locator('main')).toContainText('Adjusted book balance');
});

test('8 · flux: drivers explain the change exactly, and the Controller approves the explanation', async () => {
  await go('/flux?account=6310');
  const drawer = page.locator('.drawer');
  await expect(drawer).toContainText('6310 Events and conferences');
  await expect(drawer.getByRole('figure').or(drawer.locator('.viz'))).toBeVisible();
  await expect(drawer).toContainText('Drivers add up to the change exactly');
  await drawer.getByRole('link', { name: 'Review the draft' }).click();
  const proposal = page.locator('.drawer');
  await proposal.getByRole('button', { name: /^Approve/ }).click();
  await expect(toast(/approved and applied/)).toBeVisible();
});

test('9 · a plain-English policy rule is compiled and shown back before it is saved', async () => {
  await go('/skills/transaction-coding');
  await page.getByLabel('New rule').fill('Never auto-post anything over $2,000');
  await expect(page.getByText('Tieout will read this as:')).toBeVisible();
  await expect(page.locator('#rule-preview')).toContainText('$2,000');
  await page.getByRole('button', { name: 'Add rule' }).click();
  await expect(toast(/new policy version/)).toBeVisible();
  await expect(page.getByText('“Never auto-post anything over $2,000”')).toBeVisible();
});

test('10 · ontology: terms explain themselves; axioms deep-link', async () => {
  await go('/recs');
  await page.getByRole('button', { name: 'reconciled' }).hover();
  await expect(page.getByRole('dialog', { name: /Definition/ })).toContainText('Why it matters');
  await go('/ontology?axiom=AX-REC-01');
  await expect(page.locator('#AX-REC-01')).toContainText('Reconciliation ties out');
});

test('11 · the audit chain verifies and the period cannot lock with work open', async () => {
  await go('/audit');
  await page.getByRole('button', { name: 'Verify chain' }).click();
  await expect(page.getByText('Chain intact.')).toBeVisible();
  await go('/close');
  await expect(page.getByRole('heading', { name: 'Ready to lock?' })).toBeVisible();
  await expect(page.locator('main')).toContainText('AX-CL-02');
});

test('12 · no client errors during the whole script', async () => {
  expect(problems).toEqual([]);
});
