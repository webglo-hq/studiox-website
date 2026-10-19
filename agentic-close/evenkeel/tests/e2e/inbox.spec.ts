import { expect, test } from '@playwright/test';
import { agentsIdle, go, open, signInAs } from './helpers';

/** Bulk approval in the inbox, as the senior accountant sees it mid-close. */

test('E-5: "Select all I can approve" leaves out flagged and low-confidence items, which are approved one at a time', async ({ page }, info) => {
  test.skip(info.project.name !== 'demo', 'runs once, against the demo build');
  test.setTimeout(6 * 60_000);
  await open(page);
  await signInAs(page, 'casey');
  await page.getByTestId('run-agents').first().click();
  await expect(page.getByTestId('next-action')).not.toHaveText('Run the close agents', { timeout: 240_000 });
  await agentsIdle(page);

  await signInAs(page, 'priya');
  await go(page, '#/inbox?tab=mine');
  const rows = page.getByTestId('proposal-row');
  await expect(rows.first()).toBeVisible();
  const individual = rows.filter({ hasText: 'approve it on its own' });
  expect(await individual.count()).toBeGreaterThan(0);
  const selectAll = page.getByRole('button', { name: /Select all I can approve/ });
  const n = Number(/\((\d+)\)/.exec((await selectAll.textContent()) ?? '')?.[1] ?? '0');
  expect(n).toBeGreaterThan(0);
  await selectAll.click();
  await expect(page.getByText(`${n} selected`)).toBeVisible();
  for (const row of await individual.all()) await expect(row.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByTestId('bulk-approve')).toHaveText(`Approve ${n}`);
  await page.getByTestId('bulk-approve').click();
  await expect(page.getByText(new RegExp(`^Approved ${n} proposals?\\.`))).toBeVisible({ timeout: 180_000 });
  await agentsIdle(page);

  // A flagged item opens on its own page, with its evidence, and is approved there.
  await go(page, '#/inbox?tab=mine');
  await individual.first().getByTestId('proposal-link').click();
  await expect(page.getByTestId('approve-one')).toBeEnabled();
  await page.getByTestId('approve-one').click();
  await expect(page.getByTestId('approve-one')).toHaveCount(0, { timeout: 180_000 });
});
