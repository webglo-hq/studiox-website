/**
 * End-to-end tests against the real server (in-memory store, fresh demo seed per run) on a random
 * high port. Browsers come from PLAYWRIGHT_BROWSERS_PATH (never `playwright install` here).
 */
import { defineConfig, devices } from '@playwright/test';

// chosen once in the main process; workers inherit it through the environment
process.env.TIEOUT_E2E_PORT ??= String(40_000 + Math.floor(Math.random() * 20_000));
const port = Number(process.env.TIEOUT_E2E_PORT);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/e2e',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  webServer: {
    command: 'npm run build:web && node --import tsx src/server/node.ts',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { STORE: 'memory', PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true' },
  },
});
