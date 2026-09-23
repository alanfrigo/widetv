import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.WIDETV_TEST_URL ?? 'http://127.0.0.1:5173',
    viewport: { width: 1366, height: 768 },
    trace: 'retain-on-failure',
  },
  webServer: process.env.WIDETV_TEST_URL ? undefined : {
    command: 'npm run dev:web -- --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
  },
});
