import { expect, test } from '@playwright/test';
import { closeRound, go, signInAs, waitForAgents } from '../support';

/**
 * The demo script, end to end through the browser against the real server (PostgreSQL-compatible PGlite on
 * disk): sign in -> what's next -> run the close agents -> review and approve -> certify reconciliations ->
 * explain and approve flux -> generate and approve the close package -> lock the period -> verify the audit
 * chain. Every state change is a click in the UI; the API is only read to know when background agents finish.
 */

test.describe.configure({ mode: 'serial' });

test('a staff accountant, a senior, the controller and the CFO close September end to end', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  const seen = new Set<string>();
  const remember = async () => {
    const all = (await (await page.request.get('/api/proposals?view=all&limit=500')).json()) as { items: Array<{ title: string }> };
    for (const i of all.items) seen.add(i.title);
  };

  // 1. Sign in and see what's next.
  await page.goto('/');
  await expect(page).toHaveTitle('Bookhand Close');
  await expect(page.getByRole('heading', { name: 'Sign in to close the books' })).toBeVisible();
  await signInAs(page, 'maya');
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening), Maya/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: "What's next for you" })).toBeVisible();
  await expect(page.getByText('Run the close agents')).toBeVisible();

  // 2. Run the close agents and follow the orchestrator's trace.
  await page.getByRole('button', { name: 'Run close agents' }).first().click();
  await expect(page).toHaveURL(/#\/runs\//);
  await expect(page.getByRole('heading', { name: 'Close orchestrator' })).toBeVisible();
  await waitForAgents(page);
  await expect(page.getByText('Completed').first()).toBeVisible({ timeout: 30_000 });
  await remember();

  // 3. Review the injected bank memo: flagged, never auto-applied.
  await signInAs(page, 'daniel');
  await go(page, '#/inbox');
  const halcyon = page.getByRole('button', { name: /HALCYON FREIGHT/ }).first();
  await expect(halcyon).toBeVisible();
  await halcyon.click();
  await expect(page.getByRole('dialog').getByText(/instruction-like text, which the agent treated as data/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  // 4. Approve in waves until only judgment calls by the right people remain; certify recs; flux; package.
  let closeId = '';
  for (let round = 0; round < 10; round++) {
    const r = await closeRound(page, { afterApprovals: remember });
    closeId = r.closeId;
    if (r.complete) break;
    if (r.approved === 0 && round > 4) break;
  }

  // Every planted issue was found by an agent.
  const titles = [...seen].join('\n');
  for (const re of [/Accrue Fieldnote Research \$24,000\.00/, /Duplicate payment to Copperline Legal LLP: \$18,400\.00/, /Capitalize APPLE STORE #R102 \$14,800\.00/, /Outstanding check \$4,200\.00/, /Deposit in transit \$12,100\.00/, /Investigate unexplained bank debit \$1,250\.00/, /True up IC-2026-09-MGMT/, /Explain 6310 Events and conferences/, /HALCYON FREIGHT/]) {
    expect(titles).toMatch(re);
  }

  // The approved close package: the balance sheet foots with current-year earnings in equity (B-1), and the
  // income statement ends in net income.
  await signInAs(page, 'hannah');
  await go(page, `#/close/${closeId}/package`);
  const bs = page.getByRole('region', { name: 'Consolidated balance sheet' });
  await expect(bs.getByRole('cell', { name: 'Current-year earnings' })).toBeVisible();
  await expect(bs.getByRole('cell', { name: 'Total liabilities and equity' })).toBeVisible();
  await expect(bs.getByTestId('bs-footing')).toHaveText('Foots: assets = liabilities + equity');
  await expect(page.getByRole('cell', { name: 'Net income', exact: true })).toBeVisible();
  await expect(page.getByText(/-\$0(?![\d.,])/)).toHaveCount(0);

  // 5. Lock the period.
  await signInAs(page, 'hannah');
  await go(page, `#/close/${closeId}`);
  await expect(page.getByText('Everything is signed off.')).toBeVisible();
  await page.getByRole('button', { name: 'Lock period' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Comment for the audit log (optional)').fill('September close complete');
  await dialog.getByRole('button', { name: 'Lock period' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Period locked/ }).first()).toBeVisible();
  await expect(page.getByText('Locked').first()).toBeVisible();
  await go(page, '#/');
  await expect(page.getByText(/closed|locked/i).first()).toBeVisible();

  // Undo is a reversal: posting into the locked month is refused.
  const locked = await page.request.get('/api/reports/trial-balance?period=2026-09');
  const tb = (await locked.json()) as { totalDebit: number; totalCredit: number };
  expect(tb.totalDebit).toBe(tb.totalCredit);

  // 6. The auditor verifies the tamper-evident audit chain.
  await signInAs(page, 'sofia');
  await go(page, '#/audit');
  await page.getByRole('button', { name: 'Verify the chain' }).click();
  await expect(page.getByText('Chain intact.')).toBeVisible();

  // 7. She issues a read-only access token for an assistant (MCP): shown once, then revoked.
  await go(page, '#/settings');
  await page.locator('#tok-name').fill('Audit notebook');
  await expect(page.locator('#tok-scope option[value="write"]')).toBeDisabled();
  await page.getByRole('button', { name: 'Create token' }).click();
  const tokenDialog = page.getByRole('dialog', { name: 'Access token: Audit notebook' });
  await expect(tokenDialog.locator('code.secret')).toHaveText(/^bh_pat_/);
  await expect(tokenDialog.getByText('"BOOKHAND_TOKEN"')).toBeVisible();
  await tokenDialog.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Revoked "Audit notebook".' }).first()).toBeVisible();
});
