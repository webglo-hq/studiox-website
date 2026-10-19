import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real server (built bundle, PGlite on disk, seeded fresh for every run).
 * Build first: npm run build. The port is random (override with E2E_PORT); the data directory lives under
 * .data/ (gitignored) and is wiped by `reset` before the server starts.
 */
process.env.E2E_PORT ??= String(20_000 + Math.floor(Math.random() * 30_000));
const port = Number(process.env.E2E_PORT);

export default defineConfig({
  testDir: 'tests/e2e/server',
  timeout: 15 * 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/server',
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
    command: 'node dist/server/main.mjs reset && node dist/server/main.mjs start',
    url: `http://127.0.0.1:${port}/api/health`,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      PORT: String(port),
      HOST: '127.0.0.1',
      BOOKHAND_DATA_DIR: '.data/e2e-server',
      ANTHROPIC_API_KEY: '',
      BOOKHAND_QUIET: 'true',
    },
  },
});
