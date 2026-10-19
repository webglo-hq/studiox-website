import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Demo personas (fictional people at the fictional Brambleway Software). */
export const PEOPLE = {
  maya: 'Maya Chen',
  daniel: 'Daniel Okafor',
  hannah: 'Hannah Weiss',
  marcus: 'Marcus Bell',
  priya: 'Priya Natarajan',
  diego: 'Diego Alvarez',
  sofia: 'Sofia Lindqvist',
  tom: 'Tom Ridley',
} as const;
export type Person = keyof typeof PEOPLE;

/** Hash navigation without reloading (a reload would restart the in-browser demo). */
export async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

/** Close any open drawer or dialog (Escape closes the top one). */
export async function closeDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 4 && (await page.getByRole('dialog').count()) > 0; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** Sign out if needed, then use the one-tap demo account. */
export async function signInAs(page: Page, who: Person): Promise<void> {
  await closeDialogs(page);
  const signOut = page.getByRole('button', { name: 'Sign out' });
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
  }
  await page.getByRole('button', { name: new RegExp(`Sign in as ${PEOPLE[who]}`) }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  const dismiss = page.getByRole('button', { name: 'Dismiss the tour' });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
}

/**
 * Select everything routine in "Needs approval" and approve what this person may approve, through the
 * confirmation step (count and total). Flagged, failed-check and low-confidence items are never part of a bulk
 * approval: `approveIndividually` opens and decides those. Returns the count approved in bulk.
 */
export async function approveAllICan(page: Page): Promise<number> {
  await go(page, '#/inbox');
  const table = page.locator('table.inbox-table');
  const empty = page.getByRole('heading', { name: 'Inbox zero' });
  await expect(table.or(empty)).toBeVisible();
  if (await empty.isVisible()) return 0;
  const selectAll = page.getByRole('checkbox', { name: 'Select all' });
  if (await selectAll.isDisabled()) return 0;
  await selectAll.check();
  const button = page.getByRole('button', { name: /^Approve \d+$/ });
  const count = Number((await button.innerText()).match(/\d+/)?.[0] ?? '0');
  if (count === 0) {
    await page.getByRole('button', { name: 'Clear' }).click();
    return 0;
  }
  await button.click();
  const confirm = page.getByRole('dialog', { name: /^Approve \d+ items?\?$/ });
  await expect(confirm.getByTestId('bulk-summary')).toContainText(`${count} item`);
  await confirm.getByRole('button', { name: /^Approve \d+ items?$/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Approved/ }).first()).toBeVisible({ timeout: 60_000 });
  return count;
}

/** Open each item kept out of bulk approval that this person may approve, look at it, and approve it on its own. */
export async function approveIndividually(page: Page): Promise<number> {
  const res = await page.request.get('/api/proposals?view=pending&limit=300');
  const items = ((await res.json()) as { items: Array<{ id: string; canApprove: boolean; bulkBlock: string | null }> }).items.filter((i) => i.canApprove && i.bulkBlock);
  for (const i of items) {
    await go(page, `#/inbox/${i.id}`);
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('Decide this one on its own.')).toBeVisible();
    await drawer.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Approved and applied.' }).first()).toBeVisible({ timeout: 60_000 });
    await closeDialogs(page);
  }
  return items.length;
}

/** Waits until no agent run is queued or running (the API is only read, never driven). */
export async function waitForAgents(page: Page, timeoutMs = 240_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    const [running, queued] = await Promise.all([page.request.get('/api/runs?status=running&limit=5'), page.request.get('/api/runs?status=queued&limit=5')]);
    if (!running.ok() || !queued.ok()) throw new Error(`cannot read agent runs (HTTP ${running.status()}): sign in first`);
    const busy = ((await running.json()) as unknown[]).length + ((await queued.json()) as unknown[]).length;
    if (busy === 0) return;
    if (Date.now() - started > timeoutMs) throw new Error('agents did not finish in time');
    await page.waitForTimeout(500);
  }
}

export async function closeState(page: Page) {
  const res = await page.request.get('/api/closes/current');
  return (await res.json()) as {
    close: { id: string; status: string };
    tasks: Array<{ id: string; key: string; status: string; canComplete: boolean; canReview: boolean; pendingProposals: number; ready: boolean; entity: string | null }>;
  };
}

async function pendingCount(page: Page): Promise<number> {
  const res = await page.request.get('/api/proposals?view=pending&limit=1');
  return ((await res.json()) as { counts: { pending: number } }).counts.pending;
}

export interface RoundOptions {
  /** Approve the flux analysis once it is ready (default true; the screenshot run pauses to capture it first). */
  approveFlux?: boolean;
  /** Called after the approval wave, e.g. to record every proposal title the agents produced. */
  afterApprovals?: () => Promise<void>;
}

/**
 * One round of the demo script, every state change a click in the UI: approve in waves (each person approves
 * what their role and limits allow), certify reconciliations (Maya prepares, Daniel reviews), complete the
 * balance-sheet certification, sign off reviewed tasks, approve flux, and generate and approve the close package
 * when it is the last thing left. Agents started by these decisions run in the background between steps.
 */
export async function closeRound(page: Page, opts: RoundOptions = {}): Promise<{ approved: number; closeId: string; complete: boolean }> {
  const approvers: Person[] = ['daniel', 'hannah', 'priya', 'marcus'];
  await waitForAgents(page);
  let approved = 0;
  for (const who of approvers) {
    await signInAs(page, who);
    if ((await pendingCount(page)) === 0) break;
    approved += await approveAllICan(page);
    approved += await approveIndividually(page);
    await waitForAgents(page);
  }
  await opts.afterApprovals?.();

  // Reconciliations: Maya prepares, Daniel reviews (maker-checker).
  await signInAs(page, 'maya');
  let recs = (await (await page.request.get('/api/recs')).json()) as { recs: Array<{ id: string | null; status: string }> };
  for (const r of recs.recs.filter((x) => x.id && ['in_progress', 'reopened', 'not_started'].includes(x.status))) {
    await go(page, `#/recs/${r.id}`);
    const prepare = page.getByRole('button', { name: 'Certify as preparer' });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (await prepare.isVisible().catch(() => false)) {
      await prepare.click();
      // B-4: an amount still unexplained (e.g. the investigated bank debit) is certified only with the preparer's note.
      const explain = page.getByRole('dialog', { name: 'Certify with an unexplained difference' });
      if (await explain.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true, () => false)) {
        await explain.getByRole('textbox').fill('ACH debit under investigation with the bank (case 4471); below clearly trivial, cleared or booked next month.');
        await explain.getByRole('button', { name: 'Certify as preparer' }).click();
      }
      await expect(page.getByRole('status').filter({ hasText: /^Certified as preparer/ }).first()).toBeVisible();
    }
  }
  await signInAs(page, 'daniel');
  recs = (await (await page.request.get('/api/recs')).json()) as { recs: Array<{ id: string | null; status: string }> };
  for (const r of recs.recs.filter((x) => x.id && x.status === 'prepared')) {
    await go(page, `#/recs/${r.id}`);
    const review = page.getByRole('button', { name: 'Certify as reviewer' });
    await expect(review).toBeVisible();
    await review.click();
    await expect(page.getByRole('status').filter({ hasText: 'Reviewed.' }).first()).toBeVisible();
  }

  // Balance-sheet certification is a people task; agent-completed tasks need a reviewer's sign-off.
  let state = await closeState(page);
  const closeId = state.close.id;
  for (const t of state.tasks.filter((x) => x.key === 'bs-recs' && x.canComplete)) {
    await go(page, `#/close/${closeId}?task=${t.id}`);
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('heading', { name: /Certify balance-sheet reconciliations/ })).toBeVisible();
    const done = drawer.getByRole('button', { name: 'Mark done' });
    if (await done.isVisible()) {
      await done.click();
      // Either it completes, or the gate explains which reconciliation is still open (next round).
      await expect(page.getByRole('status').filter({ hasText: 'Task completed.' }).or(page.getByRole('alert').filter({ hasText: /reconciliation/ })).first()).toBeVisible();
    }
    await closeDialogs(page);
  }
  for (const who of ['daniel', 'hannah'] as Person[]) {
    await signInAs(page, who);
    await go(page, `#/close/${closeId}`);
    await expect(page.getByRole('list', { name: 'Close calendar by workday' })).toBeVisible();
    const signOff = page.getByRole('button', { name: /^Sign off \d+ ready task/ });
    if (await signOff.isVisible()) {
      await signOff.click();
      await expect(page.getByRole('status').filter({ hasText: /^Signed off/ }).first()).toBeVisible();
    }
  }

  // Flux: once every material variance has an accepted explanation, the Controller approves the analysis.
  if (opts.approveFlux !== false) {
    await signInAs(page, 'hannah');
    await go(page, '#/flux');
    await expect(page.getByRole('heading', { name: 'Flux review', level: 1 })).toBeVisible();
    const approveFlux = page.getByRole('button', { name: 'Approve analysis' });
    if (await approveFlux.isVisible()) {
      await approveFlux.click();
      await expect(page.getByRole('status').filter({ hasText: 'Flux analysis approved.' }).first()).toBeVisible();
      await waitForAgents(page);
    }
  }

  // The close package: the Senior Accountant generates it when it is the last thing left; the Controller approves.
  state = await closeState(page);
  const pkg = state.tasks.find((t) => t.key === 'close-package');
  if (pkg?.ready && pkg.status !== 'done' && pkg.status !== 'ready_for_review' && pkg.pendingProposals === 0) {
    await signInAs(page, 'daniel');
    await go(page, `#/close/${closeId}/package`);
    await page.getByRole('button', { name: /^(Generate|Regenerate)$/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Package generated for approval.' }).first()).toBeVisible();
    await waitForAgents(page);
    await signInAs(page, 'hannah');
    await go(page, `#/close/${closeId}/package`);
    await page.getByRole('button', { name: 'Approve package' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Close package approved.' }).first()).toBeVisible();
    await expect(page.getByText('Final').first()).toBeVisible();
    await go(page, `#/close/${closeId}`);
    await expect(page.getByRole('list', { name: 'Close calendar by workday' })).toBeVisible();
    const signOff = page.getByRole('button', { name: /^Sign off \d+ ready task/ });
    if (await signOff.isVisible()) {
      await signOff.click();
      await expect(page.getByRole('status').filter({ hasText: /^Signed off/ }).first()).toBeVisible();
    }
  }

  state = await closeState(page);
  return { approved, closeId, complete: state.tasks.every((t) => t.key === 'lock' || t.status === 'done') };
}

/**
 * As a signed-in administrator, add a person; then, signed out, open the person's demo delivery log, choose their
 * password with the single-use enrolment link and sign in as them. The administrator never sees a credential.
 */
export async function addPersonAndEnrol(page: Page, p: { name: string; email: string; role: string; entity?: string; password: string }): Promise<void> {
  await go(page, '#/admin');
  await page.getByRole('button', { name: 'Add person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a person' });
  await dialog.getByLabel('Name', { exact: true }).fill(p.name);
  await dialog.getByLabel('Work email').fill(p.email);
  await dialog.getByRole('checkbox', { name: /^Staff Accountant/ }).uncheck();
  await dialog.getByRole('checkbox', { name: new RegExp(`^${p.role}`) }).check();
  if (p.entity) await dialog.getByLabel(`${p.role}: which entities`).selectOption(p.entity);
  await dialog.getByRole('button', { name: 'Add person and send link' }).click();
  await expect(page.getByRole('status').filter({ hasText: `${p.name} added. A single-use enrolment link went to ${p.email}` })).toBeVisible();
  await expect(page.getByText(/temporary password/i)).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('link', { name: 'Open your messages in the demo delivery log' }).click();
  await page.getByLabel('Your email address').fill(p.email);
  await page.getByRole('button', { name: 'Open my messages' }).click();
  await page.getByRole('button', { name: 'Set my password' }).click();
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
  await page.getByLabel('New password').fill(p.password);
  await page.getByLabel('Repeat the password').fill(p.password);
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('heading', { name: 'Your password is set' })).toBeVisible();
  await page.getByRole('button', { name: 'Go to sign in' }).click();
  await page.getByLabel('Work email').fill(p.email);
  await page.getByLabel('Password', { exact: true }).fill(p.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

/** WCAG 2.2 A/AA checks on the current screen; returns readable violations. */
export async function axeViolations(page: Page, exclude: string[] = []): Promise<string[]> {
  // @axe-core/playwright types against its own playwright-core; the runtime object is the same page.
  let builder = new AxeBuilder({ page: page as never }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  for (const sel of exclude) builder = builder.exclude(sel);
  const result = await builder.analyze();
  return result.violations.map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}
