import { defineConfig, devices } from '@playwright/test';

/**
 * Checks the zero-install static demo (npm run build:demo -> dist-demo/index.html) served by a plain static
 * file server: no backend, no network beyond the page itself. Random port (override with DEMO_PORT).
 */
process.env.DEMO_PORT ??= String(20_000 + Math.floor(Math.random() * 30_000));
const port = Number(process.env.DEMO_PORT);

export default defineConfig({
  testDir: 'tests/e2e/demo',
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/demo',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 30_000,
    navigationTimeout: 120_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node scripts/serve-static.mjs dist-demo ${port}`,
    url: `http://127.0.0.1:${port}/`,
    timeout: 30_000,
    reuseExistingServer: false,
    stdout: 'ignore',
  },
});
