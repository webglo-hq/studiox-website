import { defineConfig, devices } from '@playwright/test';

/**
 * Captures the README / docs screenshots (desktop 1440x900 and phone 390x844) into docs/screenshots/ from a
 * freshly seeded server. Build first: npm run build. Random port (override with SHOTS_PORT).
 */
process.env.SHOTS_PORT ??= String(20_000 + Math.floor(Math.random() * 30_000));
const port = Number(process.env.SHOTS_PORT);

export default defineConfig({
  testDir: 'tests/e2e/screenshots',
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/screenshots',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 30_000,
    navigationTimeout: 120_000,
    colorScheme: 'light',
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
      BOOKHAND_DATA_DIR: '.data/e2e-shots',
      ANTHROPIC_API_KEY: '',
      BOOKHAND_QUIET: 'true',
    },
  },
});
