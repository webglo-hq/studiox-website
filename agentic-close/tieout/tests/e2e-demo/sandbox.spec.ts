/**
 * The static demo must work where artifacts are hosted: inside a sandboxed iframe (scripts only,
 * opaque origin, Web Storage throws), with no network access at all, and on a phone screen.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const html = () => readFileSync(resolve('dist/demo/index.html'), 'utf8');

test('runs inside a sandboxed iframe with an opaque origin and no storage', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent('<!doctype html><title>Host page</title><iframe id="f" sandbox="allow-scripts" title="Tieout demo" style="width:1280px;height:820px;border:0"></iframe>');
  await page.evaluate((src) => void ((document.getElementById('f') as HTMLIFrameElement).srcdoc = src), html());
  const frame = page.frameLocator('#f');
  await frame.getByRole('button', { name: /Casey Morgan/ }).click();
  await expect(frame.getByRole('heading', { level: 1, name: 'Welcome back, Casey.' })).toBeVisible();
  await frame.getByRole('button', { name: /Run close agents/ }).first().click();
  await expect(frame.getByRole('dialog', { name: 'Close agents finished' })).toBeVisible({ timeout: 60_000 });
  expect(errors).toEqual([]);
});

test('makes no network requests beyond its own file', async ({ page, baseURL }) => {
  const requests: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('file:') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) requests.push(r.url());
  });
  await page.goto(baseURL!);
  await page.getByRole('button', { name: /Riley Chen/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome back, Riley.' })).toBeVisible();
  await page.evaluate(() => void (window.location.hash = '/ontology'));
  await expect(page.getByRole('heading', { level: 1, name: 'Close ontology' })).toBeVisible();
  expect(requests).toEqual([]);
});

test('fits a phone screen without horizontal scrolling', async ({ browser, baseURL }) => {
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.goto(baseURL!);
  await phone.getByRole('button', { name: /Sam Rivera/ }).click();
  await expect(phone.getByRole('heading', { level: 1, name: 'Welcome back, Sam.' })).toBeVisible();
  const routes = ['/home', '/close', '/inbox', '/recs', '/flux', '/journal', '/reports', '/reports?view=tb', '/runs', '/skills', '/skills/bank-reconciliation', '/ontology', '/ontology?view=axioms', '/audit', '/admin', '/admin?tab=account', '/imports'];
  for (const route of routes) {
    await phone.evaluate((h) => void (window.location.hash = h), route);
    await phone.waitForTimeout(400);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, route).toBeLessThanOrEqual(1);
  }
  await phone.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(phone.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  await phone.getByRole('button', { name: 'Close menu' }).click();
  await phone.getByRole('button', { name: 'Sign out' }).click(); // top bar controls stay reachable on a phone
  await expect(phone.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await phone.close();
});
