import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 4799);
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: /.*\.spec\.js/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } },
  webServer: { command: `node test/e2e/server.js`, url: `http://127.0.0.1:${PORT}/healthz`, reuseExistingServer: false, timeout: 60_000, env: { E2E_PORT: String(PORT) } },
});
