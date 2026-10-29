import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';

const API = 8788;
const WEB = 5174;

/** End-to-end tests run the real server (embedded PGlite database) and the real web app, in demo mode. */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://127.0.0.1:${WEB}`, timezoneId: 'America/New_York', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'tablet', use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 } }, testMatch: /responsive/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /responsive/ },
  ],
  webServer: [
    {
      command: 'pnpm --filter @secretary/server exec tsx src/main.ts',
      url: `http://127.0.0.1:${API}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        PORT: String(API),
        HOST: '127.0.0.1',
        DATABASE_URL: 'pglite:memory',
        MASTER_KEY: randomBytes(32).toString('base64'),
        PUBLIC_URL: `http://127.0.0.1:${API}`,
        APP_URL: `http://127.0.0.1:${WEB}`,
        WEB_ORIGINS: `http://127.0.0.1:${WEB}`,
        JOBS_ENABLED: 'false',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${WEB} --strictPort`,
      url: `http://127.0.0.1:${WEB}`,
      reuseExistingServer: false,
      env: { VITE_DEV_API: `http://127.0.0.1:${API}` },
    },
  ],
});
