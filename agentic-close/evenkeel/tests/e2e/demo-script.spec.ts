import { expect, test, type Page } from '@playwright/test';
import { agentsIdle, approveAllMine, go, open, signInAs } from './helpers';

/**
 * The demo script, end to end, as the people who would do it:
 * log in → see what's next → run agents → review and approve (and reject one, with a reason)
 * → certify reconciliations → review them → explain flux → disposition exceptions
 * → complete task reviews → approve the close package → lock the period → verify the audit chain.
 */

async function certifyAll(page: Page): Promise<number> {
  await go(page, '#/recs');
  const rows = page.locator('[data-testid="rec-table"] tbody tr');
  await expect(rows.first()).toBeVisible();
  const n = await rows.count();
  let certified = 0;
  for (let i = 0; i < n; i++) {
    await go(page, '#/recs');
    await expect(rows.nth(i)).toBeVisible();
    await rows.nth(i).click();
    const certify = page.getByTestId('certify');
    const signedOff = page.getByText(/Signed off|Certified by/).first();
    await expect(certify.or(page.getByTestId('review-signoff')).or(signedOff)).toBeVisible();
    if ((await certify.isVisible()) && (await certify.isEnabled())) {
      await certify.click();
      await expect(page.getByTestId('review-signoff')).toBeVisible();
      certified++;
    }
  }
  return certified;
}

async function reviewAllRecs(page: Page): Promise<number> {
  await go(page, '#/recs');
  const rows = page.locator('[data-testid="rec-table"] tbody tr');
  await expect(rows.first()).toBeVisible();
  const n = await rows.count();
  let reviewed = 0;
  for (let i = 0; i < n; i++) {
    await go(page, '#/recs');
    await expect(rows.nth(i)).toBeVisible();
    await rows.nth(i).click();
    const signoff = page.getByTestId('review-signoff');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForTimeout(150);
    if ((await signoff.isVisible()) && (await signoff.isEnabled())) {
      await signoff.click();
      await page.getByTestId('confirm-review').click();
      await expect(page.getByText('Signed off', { exact: false }).first()).toBeVisible();
      reviewed++;
    }
  }
  return reviewed;
}

async function completeReviews(page: Page): Promise<number> {
  let done = 0;
  for (let i = 0; i < 20; i++) {
    await go(page, '#/cockpit');
    await expect(page.getByTestId('task-table')).toBeVisible();
    const btn = page.locator('[data-testid^="complete-T"]:enabled').first();
    if (!(await btn.isVisible().catch(() => false))) break;
    await btn.click();
    await expect(page.getByText(/completed\.$/).first()).toBeVisible();
    done++;
  }
  return done;
}

test('the September close, end to end', async ({ page }, info) => {
  const shots = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) });

  // 1. Sign in and see what is next.
  await open(page);
  await signInAs(page, 'casey');
  await expect(page.getByTestId('next-action')).toHaveText('Run the close agents');

  // 2. Run the agents.
  await page.getByTestId('run-agents').first().click();
  await expect(page.getByTestId('next-action')).not.toHaveText('Run the close agents', { timeout: 240_000 });
  await agentsIdle(page);
  await go(page, '#/inbox');
  await expect(page.getByTestId('proposal-row').first()).toBeVisible();
  await shots('inbox');

  // 3. Reject one proposal with a reason: the gift-card purchase the policy blocked.
  await page.getByRole('searchbox', { name: 'Search proposals' }).fill('Brightleaf');
  await page.getByTestId('proposal-row').first().click();
  await page.getByRole('button', { name: 'Reject…' }).click();
  await page.getByLabel('Why are you rejecting?').fill('Gift cards are not a business expense; recover from the cardholder.');
  await page.getByTestId('confirm-reject').click();
  await expect(page.getByText(/Rejected 1 proposal/)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('searchbox', { name: 'Search proposals' }).fill('');

  // 4. Approve, as the controller and the senior accountant (maker-checker), until nothing waits.
  let rounds = 0;
  for (; rounds < 10; rounds++) {
    const a = await approveAllMine(page);
    await signInAs(page, 'priya');
    const b = await approveAllMine(page);
    await signInAs(page, 'casey');
    if (a + b === 0) break;
  }
  await go(page, '#/inbox?tab=waiting');
  await expect(page.getByText('Nothing here').or(page.getByText('Nothing is waiting for you'))).toBeVisible();

  // 5. Certify reconciliations (staff accountant) and review them (senior accountant).
  await signInAs(page, 'sam');
  const certified = await certifyAll(page);
  expect(certified).toBeGreaterThan(0);
  await signInAs(page, 'priya');
  const reviewed = await reviewAllRecs(page);
  expect(reviewed).toBe(certified);
  await go(page, '#/recs');
  await expect(page.getByText(/12 of 12 signed off/)).toBeVisible();
  await shots('recs');

  // 6. Flux: the material marketing variance is explained by drivers.
  await go(page, '#/flux?entity=US&cmp=prior_month');
  await page.getByTestId('flux-6400').click();
  await expect(page.getByRole('heading', { name: 'Explanation' })).toBeVisible();
  await expect(page.getByText(/Brightstage/).first()).toBeVisible();
  await shots('flux');
  await page.keyboard.press('Escape');

  // 7. Disposition the exceptions (controller).
  await signInAs(page, 'casey');
  await go(page, '#/issues');
  const resolveButtons = page.getByTestId('resolve-issue');
  await expect(resolveButtons.first().or(page.getByText('No open exceptions'))).toBeVisible();
  for (let open = await resolveButtons.count(); open > 0; open--) {
    await resolveButtons.first().click();
    await page.getByLabel('Note').fill('Investigated during the close; correcting entry posted or follow-up assigned.');
    await page.getByTestId('confirm-issue').click();
    await expect(resolveButtons).toHaveCount(open - 1);
  }
  await expect(page.getByText('No open exceptions')).toBeVisible();

  // 8. Reviewers complete the prepared tasks.
  let completed = await completeReviews(page);
  await signInAs(page, 'priya');
  completed += await completeReviews(page);
  await signInAs(page, 'casey');
  completed += await completeReviews(page);
  expect(completed).toBeGreaterThan(0);

  // 9. The CFO approves the close package.
  await signInAs(page, 'jordan');
  await go(page, '#/package');
  await page.getByTestId('approve-package').click();
  await page.getByTestId('confirm-package').click();
  await expect(page.getByText(/Package approved and signed/)).toBeVisible();
  await shots('package');

  // 10. The controller locks the month.
  await signInAs(page, 'casey');
  await go(page, '#/cockpit');
  await expect(page.getByTestId('lock-period')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('lock-period').click();
  await page.getByTestId('confirm-lock').click();
  await expect(page.getByText(/is locked/).first()).toBeVisible();
  await go(page, '#/');
  await expect(page.getByTestId('next-action')).toHaveText(/is locked/);
  await shots('locked');

  // 11. The audit chain verifies.
  await go(page, '#/audit');
  await page.getByTestId('verify-chain').click();
  await expect(page.getByText('Chain intact')).toBeVisible();
  info.annotations.push({ type: 'rounds', description: String(rounds + 1) });
});
