import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { agentsIdle, go, open, signInAs } from './helpers';

/**
 * Automated WCAG 2.2 A/AA checks (axe-core) on every screen, in light and dark themes, at
 * desktop and phone widths, mid-close (after the agents have run). Runs against the
 * zero-install demo build, which renders the same app as the server.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function audit(page: Page, label: string): Promise<string[]> {
  await expect(page.locator('.skeleton')).toHaveCount(0, { timeout: 60_000 });
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return r.violations.map((v) => `${label}: ${v.id} (${v.impact}) ×${v.nodes.length} — ${v.help} — e.g. ${v.nodes[0]?.target.join(' ')}`);
}

async function openFirst(page: Page, table: string): Promise<void> {
  const row = page.locator(`[data-testid="${table}"] tbody tr`).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

const SCREENS: [string, string, string | null][] = [
  ['my close', '#/', null],
  ['cockpit', '#/cockpit', 'task-table'],
  ['inbox', '#/inbox?tab=mine', 'inbox-table'],
  ['reconciliations', '#/recs', 'rec-table'],
  ['flux', '#/flux', 'flux-table'],
  ['exceptions', '#/issues', null],
  ['close package', '#/package', null],
  ['journal entries', '#/journals', 'je-table'],
  ['statements', '#/reports', null],
  ['trial balance', '#/reports?view=tb', 'tb-table'],
  ['agent runs', '#/runs', 'runs-table'],
  ['skills', '#/skills', null],
  ['skill detail', '#/skills/bank-reconciliation', null],
  ['ontology', '#/ontology', null],
  ['ontology graph', '#/ontology?tab=graph', null],
  ['ontology term', '#/ontology/ek:Accrual', null],
  ['audit log', '#/audit', 'audit-table'],
  ['admin', '#/admin', null],
  ['account', '#/account', null],
];

test('every screen passes automated WCAG 2.2 AA checks in light and dark themes', async ({ page }, info) => {
  test.skip(info.project.name !== 'demo', 'runs once, against the demo build');
  test.setTimeout(10 * 60_000);
  const problems: string[] = [];
  await open(page);
  problems.push(...(await audit(page, 'sign-in')));
  await signInAs(page, 'casey');
  await page.getByTestId('run-agents').first().click();
  await expect(page.getByTestId('next-action')).not.toHaveText('Run the close agents', { timeout: 240_000 });
  await agentsIdle(page);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [name, hash, table] of SCREENS) {
      await go(page, hash);
      if (table) await expect(page.getByTestId(table)).toBeVisible({ timeout: 60_000 });
      else await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
      problems.push(...(await audit(page, `${name} (${scheme})`)));
    }
    // Detail views and dialogs.
    await go(page, '#/inbox?tab=mine');
    await openFirst(page, 'inbox-table');
    problems.push(...(await audit(page, `proposal drawer (${scheme})`)));
    await page.keyboard.press('Escape');
    await go(page, '#/recs');
    await openFirst(page, 'rec-table');
    problems.push(...(await audit(page, `reconciliation workbench (${scheme})`)));
    await go(page, '#/journals');
    await openFirst(page, 'je-table');
    problems.push(...(await audit(page, `journal entry (${scheme})`)));
    await go(page, '#/runs');
    await openFirst(page, 'runs-table');
    problems.push(...(await audit(page, `run trace (${scheme})`)));
  }

  // Phone width: navigation drawer and the inbox.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, '#/');
  await expect(page.getByTestId('next-action')).toBeVisible();
  problems.push(...(await audit(page, 'my close (phone)')));
  await page.getByRole('button', { name: 'Open navigation' }).click();
  problems.push(...(await audit(page, 'navigation drawer (phone)')));
  await page.keyboard.press('Escape');
  await go(page, '#/inbox?tab=mine');
  await expect(page.getByTestId('inbox-table')).toBeVisible();
  problems.push(...(await audit(page, 'inbox (phone)')));

  console.log(`[a11y] ${SCREENS.length * 2 + 8 + 4} views checked against ${TAGS.join(', ')}; ${problems.length} violation group(s).`);
  expect(problems, problems.join('\n')).toEqual([]);
});
