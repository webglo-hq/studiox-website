/*
 * `npm run screenshots`: capture the product at 1440×900 (desktop) and 390×844 (phone) into
 * docs/screenshots/, by driving the zero-install demo build through the close: sign in, run
 * the agents, then visit each screen. Build the demo first (npm run build:demo).
 * Uses the Playwright Chromium already installed (set PLAYWRIGHT_BROWSERS_PATH if needed).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { fromRoot } from '../src/server/paths';

const OUT = fromRoot('docs', 'screenshots');

async function serveDemo(): Promise<{ url: string; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [fromRoot('scripts', 'static-serve.mjs'), fromRoot('dist-demo'), '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise<string>((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /http:\/\/[^\s]+/.exec(buf);
      if (m) resolve(m[0].replace(/\/$/, ''));
    });
    child.on('exit', (code) => reject(new Error(`static server exited (${code})`)));
  });
  return {
    url,
    stop: () =>
      new Promise((r) => {
        child.once('exit', () => r());
        child.kill('SIGTERM');
      }),
  };
}

const go = (page: Page, hash: string) => page.evaluate((h) => (window.location.hash = h), hash);
const idle = (page: Page) => expect(page.getByTestId('agents-state')).toHaveAttribute('data-state', 'idle', { timeout: 240_000 });

/** Wait for the page to settle: no loading skeletons, fonts ready, a short pause for charts. */
async function settle(page: Page): Promise<void> {
  await expect(page.locator('.skeleton')).toHaveCount(0, { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

async function shot(page: Page, name: string, opts: { fullPage?: boolean } = {}): Promise<void> {
  // Confirmation toasts are transient; keep them out of the pictures.
  for (const b of await page.locator('.toast button[aria-label="Dismiss"]').all()) await b.click().catch(() => undefined);
  await settle(page);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: opts.fullPage ?? false });
  console.log(`  ${name}.png`);
}

async function startClose(browser: Browser, url: string, viewport: { width: number; height: number }, dpr: number): Promise<Page> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: dpr, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${url}/index.html`);
  await expect(page.getByTestId('persona-casey')).toBeVisible({ timeout: 120_000 });
  return page;
}

async function signIn(page: Page, who = 'casey'): Promise<void> {
  await page.getByTestId(`persona-${who}`).click();
  await go(page, '#/');
  await expect(page.getByTestId('next-action')).toBeVisible({ timeout: 60_000 });
  await idle(page);
}

/** Sign out (from the navigation drawer on a phone) and sign in as someone else; the demo's data stays. */
async function switchTo(page: Page, who: string): Promise<void> {
  if (await page.locator('.drawer').isVisible()) await page.keyboard.press('Escape');
  const menu = page.getByRole('button', { name: 'Open navigation' });
  if ((await menu.isVisible()) && !(await page.locator('.shell[data-nav-open="true"]').count())) await menu.click();
  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId(`persona-${who}`)).toBeVisible({ timeout: 60_000 });
  await signIn(page, who);
}

async function runAgents(page: Page): Promise<void> {
  await page.getByTestId('run-agents').first().click();
  await expect(page.getByTestId('next-action')).not.toHaveText('Run the close agents', { timeout: 240_000 });
  await idle(page);
}

/** Open the first row of a table whose text matches, or the first row. */
async function openRow(page: Page, table: string, match?: RegExp): Promise<void> {
  const rows = page.locator(`[data-testid="${table}"] tbody tr`);
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  const row = match ? rows.filter({ hasText: match }).first() : rows.first();
  await (((await row.count()) > 0 ? row : rows.first()).click());
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function desktop(browser: Browser, url: string): Promise<void> {
  console.log('Desktop 1440×900');
  const page = await startClose(browser, url, { width: 1440, height: 900 }, 1);
  await shot(page, 'desktop-01-sign-in');
  await signIn(page);
  await shot(page, 'desktop-02-my-close-start');
  await runAgents(page);
  await shot(page, 'desktop-03-my-close-after-agents');
  await go(page, '#/cockpit');
  await expect(page.getByTestId('task-table')).toBeVisible();
  await shot(page, 'desktop-04-cockpit');
  // Casey started the agents, so their proposals wait for others: the inbox as Priya sees it.
  await switchTo(page, 'priya');
  await go(page, '#/inbox?tab=mine');
  await expect(page.getByTestId('inbox-table')).toBeVisible();
  await shot(page, 'desktop-05-inbox');
  await openRow(page, 'inbox-table', /Accrue Northgate/);
  await shot(page, 'desktop-06-proposal-why');
  await go(page, '#/inbox?tab=all');
  await expect(page.getByTestId('inbox-table')).toBeVisible();
  await openRow(page, 'inbox-table', /Suspicious outgoing wire/);
  await shot(page, 'desktop-07-guardrail-injection');
  await switchTo(page, 'casey');
  await go(page, '#/recs');
  await openRow(page, 'rec-table', /Operating|Checking|Cash/i);
  await shot(page, 'desktop-08-reconciliation-workbench');
  await go(page, '#/flux');
  await expect(page.getByTestId('flux-table')).toBeVisible();
  await shot(page, 'desktop-09-flux');
  await go(page, '#/journals');
  await openRow(page, 'je-table', /Accru|Reclass|Depreciation/i);
  await shot(page, 'desktop-10-journal-entry');
  await go(page, '#/reports?view=is&scope=consolidated');
  await shot(page, 'desktop-11-income-statement');
  await go(page, '#/runs');
  await openRow(page, 'runs-table', /Bank|reconcil/i);
  await shot(page, 'desktop-12-run-trace');
  await go(page, '#/skills/bank-reconciliation');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, 'desktop-13-skill-policy');
  await go(page, '#/ontology?tab=graph');
  await expect(page.locator('.graph-wrap svg')).toBeVisible({ timeout: 60_000 });
  await page.locator('.graph-wrap').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, 'desktop-14-ontology-graph');
  await go(page, '#/audit');
  await expect(page.getByTestId('audit-table')).toBeVisible();
  await shot(page, 'desktop-15-audit-log');
  await page.emulateMedia({ colorScheme: 'dark' });
  await go(page, '#/cockpit');
  await expect(page.getByTestId('task-table')).toBeVisible();
  await shot(page, 'desktop-16-cockpit-dark');
  await switchTo(page, 'priya');
  await go(page, '#/inbox?tab=mine');
  await expect(page.getByTestId('inbox-table')).toBeVisible();
  await shot(page, 'desktop-17-inbox-dark');
  await page.context().close();
}

async function phone(browser: Browser, url: string): Promise<void> {
  console.log('Phone 390×844 (device scale 2)');
  const page = await startClose(browser, url, { width: 390, height: 844 }, 2);
  await shot(page, 'phone-01-sign-in');
  await signIn(page);
  await runAgents(page);
  await shot(page, 'phone-02-my-close');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.waitForTimeout(300);
  await shot(page, 'phone-03-navigation');
  await page.keyboard.press('Escape');
  await switchTo(page, 'priya');
  await go(page, '#/inbox?tab=mine');
  await expect(page.getByTestId('inbox-table')).toBeVisible();
  await shot(page, 'phone-04-inbox');
  await openRow(page, 'inbox-table', /Accrue Northgate/);
  await shot(page, 'phone-05-proposal');
  await switchTo(page, 'casey');
  await go(page, '#/recs');
  await openRow(page, 'rec-table', /Operating|Checking|Cash/i);
  await shot(page, 'phone-06-reconciliation');
  await page.context().close();
}

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith('.png')) rmSync(join(OUT, f));
const server = await serveDemo();
const browser = await chromium.launch();
try {
  await desktop(browser, server.url);
  await phone(browser, server.url);
} finally {
  await browser.close();
  await server.stop();
}
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
const total = files.reduce((n, f) => n + statSync(join(OUT, f)).size, 0);
console.log(`${files.length} screenshots, ${(total / 1024 / 1024).toFixed(2)} MB in ${OUT}`);
if (total > 6 * 1024 * 1024) {
  console.error('Screenshots exceed the 6 MB budget.');
  process.exit(1);
}
