/**
 * End-to-end tests of the zero-install static demo (dist/demo, built by `npm run build:demo`):
 * the same demo script, opened straight from disk (file://) with no server at all, plus a check
 * that the page runs inside a sandboxed iframe with an opaque origin and no storage.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: ['e2e/demo-script.spec.ts', 'e2e-demo/*.spec.ts'],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/e2e-demo',
  use: { baseURL: pathToFileURL(resolve('dist/demo/index.html')).href, trace: 'retain-on-failure', screenshot: 'only-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
});
