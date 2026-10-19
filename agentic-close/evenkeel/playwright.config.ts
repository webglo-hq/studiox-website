import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests of the full demo script, against both the real server (password sign-in,
 * embedded Postgres) and the zero-install static demo (in-browser backend).
 * Ports are random high ports unless E2E_SERVER_PORT / E2E_DEMO_PORT are set; each run uses a
 * fresh database directory under .data/ (gitignored), deleted when the server stops.
 */
// The config is evaluated by the runner and again by each worker: pick the ports once and
// hand them down through the environment so every process agrees.
process.env.E2E_SERVER_PORT ??= String(20000 + Math.floor(Math.random() * 25000));
process.env.E2E_DEMO_PORT ??= String(20000 + Math.floor(Math.random() * 25000));
const serverPort = Number(process.env.E2E_SERVER_PORT);
const demoPort = Number(process.env.E2E_DEMO_PORT);
const dataDir = `.data/e2e-${serverPort}`;
const only = process.env.E2E_ONLY; // 'server' | 'demo'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 8 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [
    // The static-demo checks (single file, workers, sandboxing) only make sense for the demo build;
    // checks that need a fresh close run once, on the demo, since the server's close ends locked.
    ...(only !== 'demo' ? [{ name: 'server', testIgnore: /(static-demo|accessibility|inbox)\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: `http://127.0.0.1:${serverPort}` } }] : []),
    ...(only !== 'server' ? [{ name: 'demo', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: `http://127.0.0.1:${demoPort}` } }] : []),
  ],
  webServer: [
    ...(only !== 'demo'
      ? [
          {
            command: `node --import tsx src/server/main.ts`,
            url: `http://127.0.0.1:${serverPort}/healthz`,
            timeout: 240_000,
            reuseExistingServer: false,
            stdout: 'ignore' as const,
            stderr: 'pipe' as const,
            env: { PORT: String(serverPort), HOST: '127.0.0.1', EVENKEEL_DATA_DIR: dataDir, EVENKEEL_EPHEMERAL: '1', DEMO_LOGIN_HELPER: '1', RATE_LIMIT_SCALE: '50', NODE_ENV: 'test' },
            // SIGTERM lets the server finish, close the database and delete its data directory.
            gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 20_000 },
          },
        ]
      : []),
    ...(only !== 'server'
      ? [
          {
            command: `node scripts/static-serve.mjs dist-demo --port ${demoPort}`,
            url: `http://127.0.0.1:${demoPort}/index.html`,
            timeout: 60_000,
            reuseExistingServer: false,
            gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5_000 },
            stdout: 'ignore' as const,
            stderr: 'pipe' as const,
          },
        ]
      : []),
  ],
});
