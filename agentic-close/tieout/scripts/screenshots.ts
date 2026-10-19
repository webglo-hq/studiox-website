/**
 * `npm run screenshots`: walks the demo story in the zero-install build (dist/demo, no server)
 * and saves desktop (1440×900) and phone (390×844) screenshots to docs/screenshots/.
 * Needs `npm run build:demo` first and Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH).
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from '@playwright/test';

const out = resolve('docs/screenshots');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const url = pathToFileURL(resolve('dist/demo/index.html')).href;

const go = (page: Page, hash: string) => page.evaluate((h) => void (window.location.hash = h), hash);
const settle = (page: Page, ms = 500) => page.waitForTimeout(ms);
const shot = async (page: Page, name: string) => {
  await settle(page);
  await page.screenshot({ path: resolve(out, `${name}.png`) });
  console.log(`  ${name}.png`);
};

async function story(page: Page) {
  await page.goto(url);
  await page.getByRole('button', { name: /Jordan Lee/ }).click();
  await page.getByRole('button', { name: /Run close agents/ }).first().click();
  await page.getByRole('dialog', { name: 'Close agents finished' }).waitFor({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: /Casey Morgan/ }).click();
  await page.locator('.topbar').waitFor();
  await page.getByRole('button', { name: /Casey Morgan/ }).waitFor({ state: 'detached' });
}

const browser = await chromium.launch();
try {
  // ---------------------------------------------------------------- desktop, light
  const desk = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await desk.goto(url);
  await desk.getByRole('button', { name: /Jordan Lee/ }).waitFor();
  await shot(desk, '01-sign-in');
  await desk.getByRole('button', { name: /Jordan Lee/ }).click();
  await desk.getByRole('button', { name: /Run close agents/ }).first().click();
  await desk.getByRole('dialog', { name: 'Close agents finished' }).waitFor({ timeout: 60_000 });
  await shot(desk, '02-close-agents-finished');
  await desk.keyboard.press('Escape');
  await desk.getByRole('button', { name: 'Sign out' }).click();
  await desk.getByRole('button', { name: /Casey Morgan/ }).click();
  await desk.locator('.topbar').getByText('Casey Morgan').waitFor();
  await go(desk, '/home');
  await shot(desk, '03-my-close');
  await go(desk, '/inbox?q=Accrue Cumulus');
  await desk.locator('.prop a.title').first().click();
  await desk.locator('.drawer').waitFor();
  await shot(desk, '04-inbox-proposal-why-evidence');
  await desk.keyboard.press('Escape');
  await go(desk, '/inbox?q=Riverside');
  await shot(desk, '05-inbox-injection-withheld');
  await go(desk, '/close');
  await shot(desk, '06-close-cockpit');
  await go(desk, '/recs');
  await desk.getByRole('row').filter({ hasText: 'First Harbor' }).getByRole('link', { name: 'Open workbench' }).click();
  await desk.getByRole('heading', { name: 'Tie-out' }).waitFor();
  await shot(desk, '07-bank-rec-workbench');
  await go(desk, '/flux?account=6310');
  await desk.locator('.drawer').waitFor();
  await shot(desk, '08-flux-drivers');
  await go(desk, '/runs');
  await desk.locator('table.data a.row-link').first().click();
  await desk.getByText('Trace').first().waitFor();
  await shot(desk, '09-agent-run-trace');
  await go(desk, '/skills/transaction-coding');
  await desk.getByLabel('New rule').fill('Never auto-post anything over $2,000');
  await desk.getByText('Tieout will read this as:').waitFor();
  await desk.mouse.wheel(0, 700);
  await shot(desk, '10-skill-policy-plain-english-rule');
  await go(desk, '/ontology?class=tie:DepositInTransit');
  await shot(desk, '11-ontology-explorer');
  await go(desk, '/audit');
  await desk.getByRole('button', { name: 'Verify chain' }).click();
  await desk.getByText('Chain intact.').waitFor();
  await shot(desk, '12-audit-chain-verified');
  await go(desk, '/reports');
  await shot(desk, '13-consolidated-statements');
  // an entry the agents posted within the Controller's policy: lines, proposal, approval route
  await go(desk, '/journal?source=agent&status=posted');
  await desk.locator('table.data a.row-link').first().click();
  await desk.locator('main h1').first().waitFor();
  await shot(desk, '18-journal-entry-detail');
  await go(desk, '/imports');
  await desk.getByRole('heading', { level: 1 }).first().waitFor();
  await shot(desk, '19-imports-provenance');
  await desk.getByRole('button', { name: 'Sign out' }).click();
  await desk.getByRole('button', { name: /Avery Stone/ }).click();
  await desk.locator('.topbar').getByText('Avery Stone').waitFor();
  await go(desk, '/admin');
  await desk.getByRole('row', { name: /Sam Rivera/ }).waitFor();
  await shot(desk, '20-admin-people-roles');
  await desk.close();

  // ---------------------------------------------------------------- desktop, dark
  const dark = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await story(dark);
  await go(dark, '/inbox');
  await shot(dark, '14-inbox-dark');
  await go(dark, '/flux?account=6310');
  await dark.locator('.drawer').waitFor();
  await shot(dark, '15-flux-dark');
  await dark.close();

  // ---------------------------------------------------------------- phone
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
  await story(phone);
  await go(phone, '/home');
  await shot(phone, '16-phone-my-close');
  await go(phone, '/inbox?q=Accrue Cumulus');
  await phone.locator('.prop a.title').first().click();
  await phone.locator('.drawer').waitFor();
  await shot(phone, '17-phone-proposal');
  await phone.close();
} finally {
  await browser.close();
}

const files = readdirSync(out);
const total = files.reduce((s, f) => s + statSync(resolve(out, f)).size, 0);
console.log(`${files.length} screenshots, ${(total / 1048576).toFixed(2)} MB in docs/screenshots/`);
if (total > 6 * 1048576) {
  console.error('screenshots exceed 6 MB');
  process.exit(1);
}
