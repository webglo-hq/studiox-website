import { expect, test } from '@playwright/test';

/**
 * The zero-install demo must work as a single file: no network calls, a Web Worker when
 * allowed, an on-page fallback when workers are blocked, and inside a sandboxed iframe
 * (opaque origin: storage throws, workers may be refused).
 */
test('boots from one file with no network calls, using a worker', async ({ page, baseURL }) => {
  const requests: string[] = [];
  page.on('request', (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  await page.goto('/');
  await expect(page.getByTestId('persona-casey')).toBeVisible({ timeout: 120_000 });
  await expect(page).toHaveTitle('Evenkeel Month-End Close');
  expect(await page.evaluate(() => document.documentElement.dataset.backend)).toBe('worker');
  await page.getByTestId('persona-casey').click();
  await expect(page.getByTestId('next-action')).toBeVisible();
  await page.evaluate(() => (window.location.hash = '#/ontology'));
  await expect(page.getByRole('heading', { name: /vocabulary/ })).toBeVisible();
  // Only the page itself was fetched: fonts, styles, scripts and the worker are inline.
  expect(requests.filter((u) => !u.startsWith(`${baseURL}/index.html`) && u !== `${baseURL}/`)).toEqual([]);
});

test('falls back to running on the page when workers are blocked', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Worker', {
      value: function BlockedWorker() {
        throw new DOMException('Workers are blocked here', 'SecurityError');
      },
    });
  });
  await page.goto('/');
  await expect(page.getByTestId('persona-priya')).toBeVisible({ timeout: 120_000 });
  expect(await page.evaluate(() => document.documentElement.dataset.backend)).toBe('page');
  await page.getByTestId('persona-priya').click();
  await expect(page.getByTestId('next-action')).toBeVisible();
});

test('runs inside a sandboxed iframe with storage blocked', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent(`<!doctype html><title>host</title><iframe id="f" sandbox="allow-scripts" src="${baseURL}/index.html" style="width:1200px;height:800px;border:0"></iframe>`);
  const frame = page.frameLocator('#f');
  await expect(frame.getByTestId('persona-sam')).toBeVisible({ timeout: 120_000 });
  await frame.getByTestId('persona-sam').click();
  await expect(frame.getByTestId('next-action')).toBeVisible();
  expect(errors).toEqual([]);
});
