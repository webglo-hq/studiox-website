import { expect, type Page } from '@playwright/test';

/**
 * Helpers for the demo-script e2e. Navigation uses hash changes only, so the zero-install
 * demo (whose database lives in the page) is never reloaded mid-test.
 */

export type Persona = 'casey' | 'priya' | 'sam' | 'jordan' | 'miguel' | 'dana' | 'alex' | 'taylor';

export async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

export async function agentsIdle(page: Page): Promise<void> {
  await expect(page.getByTestId('agents-state')).toHaveAttribute('data-state', 'idle', { timeout: 240_000 });
}

export async function open(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('persona-casey').or(page.getByTestId('sign-out'))).toBeVisible({ timeout: 120_000 });
}

export async function signInAs(page: Page, who: Persona): Promise<void> {
  const signOut = page.getByTestId('sign-out');
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
  }
  const persona = page.getByTestId(`persona-${who}`);
  await expect(persona).toBeVisible({ timeout: 60_000 });
  await persona.click();
  await expect(page.getByTestId('sign-out')).toBeVisible({ timeout: 60_000 });
  await go(page, '#/');
  await expect(page.getByTestId('next-action')).toBeVisible({ timeout: 60_000 });
  await agentsIdle(page);
}

/**
 * Approve everything the signed-in person may approve: routine items in bulk, then each item
 * that must be opened and approved on its own (flagged, low confidence, held by a policy rule).
 * Returns how many were approved.
 */
export async function approveAllMine(page: Page): Promise<number> {
  let total = 0;
  for (let i = 0; i < 30; i++) {
    await go(page, '#/inbox?tab=mine');
    const selectAll = page.getByRole('button', { name: /Select all I can approve/ });
    const empty = page.getByText('Nothing is waiting for you');
    await expect(selectAll.or(empty).or(page.getByTestId('inbox-table')).first()).toBeVisible({ timeout: 60_000 });
    if (await empty.isVisible()) break;
    if (await selectAll.isVisible()) {
      const label = (await selectAll.textContent()) ?? '';
      const n = Number(/\((\d+)\)/.exec(label)?.[1] ?? '0');
      await selectAll.click();
      await page.getByTestId('bulk-approve').click();
      // The selection clears when the decision returns; then wait for any agents it started.
      await expect(page.getByTestId('bulk-approve')).toHaveCount(0, { timeout: 180_000 });
      await agentsIdle(page);
      total += n;
      continue;
    }
    const single = page.getByTestId('proposal-row').filter({ hasText: 'approve it on its own' }).first();
    if (!(await single.isVisible().catch(() => false))) break;
    await single.getByTestId('proposal-link').click();
    await page.getByTestId('approve-one').click();
    await expect(page.getByTestId('approve-one')).toHaveCount(0, { timeout: 180_000 });
    await page.keyboard.press('Escape');
    await agentsIdle(page);
    total += 1;
  }
  return total;
}

/** As a close lead: when approvals have unblocked tasks, continue the close from My close. Returns 1 if it did. */
export async function continueClose(page: Page): Promise<number> {
  await go(page, '#/');
  await expect(page.getByTestId('next-action')).toBeVisible({ timeout: 60_000 });
  if ((await page.getByTestId('next-action').textContent()) !== 'Continue the close') return 0;
  await page.getByTestId('run-agents').first().click();
  await expect(page.getByTestId('next-action')).not.toHaveText('Continue the close', { timeout: 240_000 });
  await agentsIdle(page);
  return 1;
}
