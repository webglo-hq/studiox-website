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
/** Open the first inbox item whose row shows `text` (waits for the list to reflect the new query). */
const openFirst = async (text: string | RegExp) => {
  await page.locator('.prop').filter({ hasText: text }).first().locator('a.title').click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toContainText(text);
  return drawer;
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

test('0 · T-4: the sign-in cards say what each person does and where a first-time user starts', async () => {
  await expect(page.getByText('New here? Start as Jordan Lee')).toBeVisible();
  await expect(page.getByRole('button', { name: /Jordan Lee/ })).toContainText('Start here: runs the close agents.');
  await expect(page.getByRole('button', { name: /Sam Rivera/ })).toContainText('Certifies reconciliations and explains variances.');
});

test('1 · sign in as the Senior Accountant of the fictional company', async () => {
  await expect(page.getByText('Bramblewood Labs is a fictional company')).toBeVisible();
  await page.getByRole('button', { name: /Jordan Lee/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome back, Jordan.' })).toBeVisible();
  await expect(page.getByText(/agents haven.t run for September 2026 yet/)).toBeVisible();
  await expect(page.locator('.period-chip')).toContainText('WD+2');
});

test('1b · T-4: My close says what is next, with a short guide to the whole close', async () => {
  const next = page.getByRole('region', { name: 'What’s next for you' });
  await expect(next).toContainText('Run the close agents for September 2026');
  await expect(next.getByRole('button', { name: 'Run close agents' })).toBeVisible();
  const guide = page.getByRole('region', { name: 'How the close runs' });
  await expect(guide.locator('[aria-current="step"]')).toContainText('Run the close agents');
  await expect(guide).toContainText('Approve the package and lock the month');
});

test('2 · run the close agents: nine checklist tasks in dependency waves', async () => {
  await page.getByRole('button', { name: /Run close agents/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Close agents finished' });
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await expect(dialog).toContainText('9 of 9 checklist tasks ran in 3 dependency waves');
  await expect(dialog).toContainText('Proposed 4 accruals totalling $515,469.00 for BWL-US');
  // T-5: checklist tasks by their names, not their keys
  await expect(dialog).toContainText('Code card transactions and bills');
  await expect(dialog).not.toContainText('code-transactions');
  await dialog.getByRole('link', { name: 'Review the inbox' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
});

test('2b · T-7: My close and the inbox count what needs a decision the same way', async () => {
  await go('/home');
  const overall = Number((await page.getByRole('link', { name: /need a decision overall/ }).innerText()).match(/\d+/)![0]);
  await go('/inbox');
  await expect(page.getByRole('button', { name: `Needs a decision (${overall})` })).toBeVisible();
  // once the agents ran, running them is no longer what's next
  await go('/home');
  await expect(page.getByRole('region', { name: 'What’s next for you' })).not.toContainText('Run the close agents');
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
  const drawer = await openFirst('Accrue Cumulus Hosting Co.');
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
  const drawer = await openFirst('Accrue Cumulus Hosting Co.');
  await expect(drawer.getByRole('heading', { name: 'Evidence' })).toBeVisible();
  await expect(drawer).toContainText('Verification');
  await drawer.getByRole('button', { name: /Approve & post/ }).click();
  await expect(toast(/approved and applied/)).toBeVisible();

  await go('/journal?q=Accrue Cumulus');
  await page.locator('table.data a.row-link').filter({ hasText: /^JE-2026-09-US/ }).first().click();
  await expect(page.locator('main')).toContainText('Approved by');
  await expect(page.locator('main')).toContainText('Casey Morgan');
  await expect(page.locator('main')).toContainText(/Posted/);
  // accruals reverse on day 1 of the next period, posted automatically once October is open
  await expect(page.locator('main')).toContainText(/JE-2026-10-US-\d+ \(posted\)/);
});

test('5b · T-3: a keyboard user opens a proposal with Enter, reads its evidence and approves it', async () => {
  await go('/inbox?q=depreciation – computer equipment');
  await inboxLoaded();
  const row = page.locator('.prop').filter({ hasText: 'Post September 2026 depreciation – computer equipment' }).first();
  // T-8: the checkbox says which item it selects
  await expect(row.getByRole('checkbox')).toHaveAccessibleName(/^Select P-\d+: Post September 2026 depreciation – computer equipment/);
  await row.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: /Post September 2026 depreciation – computer equipment/ });
  await expect(drawer).toBeVisible();
  await page.waitForTimeout(400); // it used to close again at once
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(drawer.getByRole('heading', { name: 'Evidence' })).toBeVisible();
  // T-5: who decides, in words, and materiality spelled out
  await expect(drawer).toContainText('Who can decide');
  await expect(drawer).toContainText('Senior Accountant, Controller, CFO, within their approval limit');
  await expect(drawer).not.toContainText(/\b(?:je|flux|close|recon|coding)\.[a-z]+\b/);
  await expect(drawer).not.toContainText('below pm');
  // Tab moves through the panel to the decision; Enter decides
  const approve = drawer.getByRole('button', { name: /Approve & post/ });
  for (let i = 0; i < 60 && !(await approve.evaluate((b) => b === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(approve).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toast(/approved and applied/)).toBeVisible();
});

test('5c · T-8: the theme button is named by the word it shows', async () => {
  const theme = page.locator('.topbar button[title*="heme"]');
  const shown = (await theme.innerText()).trim();
  expect(shown).toBe('Auto');
  await expect(theme).toHaveAccessibleName(/^Auto theme/);
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

// ------------------------------------------------------------------ finishing the close
const signInAs = async (name: string) => {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.locator('.topbar')).toContainText(name);
};
/** A checklist task by its title (other tasks mention it as a prerequisite). */
const taskNamed = (title: string) => page.locator('.task').filter({ has: page.locator('.title').getByText(title, { exact: true }) });
/** The inbox list shows the data for the current URL (it is aria-busy while a query loads). */
const inboxLoaded = async () => {
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await page.waitForTimeout(150); // let the route change start its query
  await expect(page.getByRole('region', { name: 'Proposals' })).not.toHaveAttribute('aria-busy', 'true', { timeout: 60_000 });
  await expect(page.locator('.prop').first().or(page.getByText('Nothing needs a decision'))).toBeVisible();
};
/** Approve in bulk everything the signed-in person may approve; again while prerequisites unlock more. */
const approveAllICan = async () => {
  for (let i = 0; i < 4; i++) {
    await go('/inbox');
    await inboxLoaded();
    const selectAll = page.getByRole('button', { name: /Select all I can approve/ });
    if (!(await selectAll.count())) return;
    await selectAll.click();
    await page.getByRole('button', { name: /Approve \d+ selected/ }).click();
    await expect(page.getByRole('button', { name: /Approve \d+ selected/ })).toHaveCount(0, { timeout: 60_000 });
  }
};

test('12 · decide everything: the Controller approves in bulk, rejects the flagged wire, the CFO approves above her limit', async () => {
  await approveAllICan();
  // items flagged for instruction-like text are never in a bulk selection: decide them one by one
  await go('/inbox?q=Riverside');
  const drawer = await openFirst('RIVERSIDE AGRICO');
  await drawer.getByRole('button', { name: 'Reject' }).click();
  const reason = page.getByRole('dialog', { name: /^Reject P-/ });
  await reason.getByRole('textbox').fill('Memo tries to instruct the agents; matched by hand after calling First Harbor.');
  await reason.getByRole('button', { name: 'Reject' }).click();
  await expect(toast(/rejected/i)).toBeVisible();
  await signInAs('Riley Chen');
  await approveAllICan();
  await go('/inbox?status=all');
  await go('/inbox');
  await inboxLoaded();
  await expect(page.getByText('Nothing needs a decision')).toBeVisible();
});

test('12b · T-4: once the decisions are made, the Staff Accountant is told what is next', async () => {
  await signInAs('Sam Rivera');
  await go('/home');
  const next = page.getByRole('region', { name: 'What’s next for you' });
  await expect(next).toContainText('Certify 6 reconciliations as preparer, noting anything still open.');
  await expect(next.getByRole('link', { name: /Certify 6 reconciliations/ })).toHaveAttribute('href', '#/recs');
});

test('13 · reconciliations: the Staff Accountant certifies, documenting what is still open', async () => {
  await signInAs('Sam Rivera');
  for (const bank of ['First Harbor', 'Thameside']) {
    await go('/recs');
    await page.getByRole('row').filter({ hasText: bank }).getByRole('link', { name: 'Open workbench' }).click();
    await page.getByRole('button', { name: 'Certify as preparer' }).click();
    const justify = page.getByRole('dialog', { name: 'Certify with open items' });
    const done = toast(/Reconciliation certified/);
    await expect(justify.or(done)).toBeVisible();
    if (await justify.isVisible()) {
      await justify.getByRole('textbox').fill('Unexplained bank debit under investigation with the bank; follow-up owner Sam, due WD+5.');
      await justify.getByRole('button', { name: 'Certify' }).click();
    }
    await expect(done).toBeVisible();
  }
  await go('/recs');
  const certify = page.getByRole('button', { name: 'Certify', exact: true });
  await expect(certify.first()).toBeVisible();
  for (let i = 0; i < 6 && (await certify.count()); i++) {
    const before = await certify.count();
    await certify.first().click();
    const diff = page.getByRole('dialog', { name: 'Certify with a difference' });
    if (await diff.isVisible()) {
      await diff.getByRole('textbox').fill('Duplicate payment to a vendor shows as an AP debit; refund requested, tracked by AP.');
      await diff.getByRole('button', { name: 'Certify' }).click();
    }
    await expect(certify).toHaveCount(before - 1);
  }
});

test('14 · flux: a person writes one explanation, the agent drafts the rest', async () => {
  await go('/flux');
  await expect(page.getByRole('heading', { level: 1, name: 'Flux analysis' })).toBeVisible();
  const needed = page.locator('tbody tr').filter({ hasText: 'Needed' });
  await expect(needed.first()).toBeVisible();
  await needed.first().getByRole('link').click();
  const drawer = page.locator('.drawer');
  await drawer.getByLabel('Your explanation').fill('Thirteen unpaid September payroll days were accrued at month-end; the accrual reverses on 1 October.');
  await drawer.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(toast(/Explanation submitted/)).toBeVisible();
  await drawer.getByRole('button', { name: 'Close' }).click();
  const draft = page.getByRole('button', { name: /^Draft \d+ explanations?$/ });
  if (await draft.count()) {
    await draft.click();
    await expect(toast(/Drafts are in the inbox/)).toBeVisible();
  }
  await expect(page.locator('tbody tr').filter({ hasText: 'Needed' })).toHaveCount(0);
});

test('15 · the Controller approves the explanations, reviews the reconciliations and signs off the checklist', async () => {
  await signInAs('Casey Morgan');
  await approveAllICan();
  for (const bank of ['First Harbor', 'Thameside']) {
    await go('/recs');
    await page.getByRole('row').filter({ hasText: bank }).getByRole('link', { name: 'Open workbench' }).click();
    await page.getByRole('button', { name: 'Review & sign' }).click();
    await expect(toast(/Reconciliation reviewed/)).toBeVisible();
  }
  await go('/recs');
  const review = page.getByRole('button', { name: 'Review', exact: true });
  await expect(review.first()).toBeVisible();
  for (let i = 0; i < 6 && (await review.count()); i++) {
    const before = await review.count();
    await review.first().click();
    await expect(review).toHaveCount(before - 1);
  }
  await go('/close');
  // T-7: every agent item is decided, and the checklist says so without contradicting itself
  await expect(page.locator('main')).toContainText('All agent items decided.');
  await expect(page.locator('main')).not.toContainText('waiting for a decision');
  // each task the Controller reviews (or may stand in for a Senior Accountant who ran its agents),
  // in dependency order: signing one can make the next one ready
  const signOff = page.getByRole('button', { name: 'Sign off' });
  await expect(signOff.first()).toBeVisible();
  for (let i = 0; i < 12 && (await signOff.count()); i++) {
    const task = page.locator('.task').filter({ has: page.getByRole('button', { name: 'Sign off' }) }).first();
    const title = await task.locator('.title').innerText();
    await signOff.first().click();
    await expect(toast(`${title}: signed off.`)).toBeVisible();
    await expect(taskNamed(title).getByRole('button', { name: 'Sign off' })).toHaveCount(0);
  }
});

test('15b · T-10: the CFO signs off the journal-entry review the Controller owns; then the package is drafted', async () => {
  const review = taskNamed('Review journal entries for risk');
  await expect(review).toContainText('You own this task, so its reviewer signs it off (SOD-01).');
  await expect(review.getByRole('button', { name: 'Sign off' })).toHaveCount(0);
  await signInAs('Riley Chen');
  await go('/close');
  await review.getByRole('button', { name: 'Sign off' }).click();
  await expect(toast('Review journal entries for risk: signed off.')).toBeVisible();
  await signInAs('Casey Morgan');
  await go('/close');
  await expect(page.locator('main')).toContainText('generate the close package first');
  await page.getByRole('button', { name: 'Draft close package' }).click();
  await expect(toast(/Close package drafted/)).toBeVisible({ timeout: 60_000 });
});

test('16 · the CFO approves and signs the close package, then locks September', async () => {
  await signInAs('Riley Chen');
  await go('/inbox?kind=report');
  const drawer = await openFirst(/close package/i);
  await drawer.getByRole('button', { name: /^Approve/ }).click();
  await expect(toast(/approved and applied/)).toBeVisible();
  await go('/close');
  await page.getByRole('button', { name: 'Finalize & sign' }).click();
  await expect(toast(/finalized and signed/)).toBeVisible();
  await expect(page.getByText('Every condition holds.')).toBeVisible();
  await page.getByRole('button', { name: 'Lock September 2026' }).click();
  await page.getByRole('dialog', { name: 'Lock September 2026?' }).getByRole('button', { name: 'Lock period' }).click();
  await expect(toast(/September 2026 is locked/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Period locked' })).toBeVisible();
  await page.getByRole('link', { name: 'Open package' }).click();
  await expect(page.locator('main')).toContainText(/final/i);
  // T-1: the gross margin is a share of revenue, shown once as a percentage (never "+8890.0%")
  await expect(page.locator('.stat').filter({ hasText: 'Gross margin' }).locator('.value')).toHaveText(/^\d{1,2}\.\d%$/);
});

test('17 · My close now says the month is closed and points to the signed package', async () => {
  await go('/home');
  await expect(page.locator('main')).toContainText('September 2026 is closed');
  await expect(page.getByRole('button', { name: /Run close agents/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Open the close package' }).click();
  await expect(page.locator('main')).toContainText(/final/i);
});

test('18 · no client errors during the whole script', async () => {
  expect(problems).toEqual([]);
});
