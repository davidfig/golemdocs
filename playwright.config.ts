// End-to-end tests: the real app in Chromium, against its own client and server (never the ones
// `pnpm dev` runs on :5173 and :3001). The server is wrangler's fully simulated local mode on a
// throwaway state folder, so no test touches real Cloudflare resources.
//
//   pnpm e2e            run everything
//   pnpm e2e --ui       watch mode with the Playwright UI
//
// Billing and the assistant (Clip) are deliberately not covered yet.

import { defineConfig, devices } from '@playwright/test';

const CLIENT_PORT = 5273;
const API_PORT = 3101;
const STATE = '../e2e/.state';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'e2e/.results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'e2e/.report' }]] : 'list',
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
    // WebGL must work headless (software rendering is fine).
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: [
    {
      // Fresh database and storage every run, then the Worker (API and collaboration rooms).
      command:
        `rm -rf e2e/.state && mkdir -p client/dist && cd server && ` +
        `pnpm exec wrangler d1 migrations apply DIRECTORY --env local --local --persist-to ${STATE} && ` +
        `pnpm exec wrangler dev --env local --port ${API_PORT} --persist-to ${STATE} --var DEV_USER:e2e@example.com`,
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
    },
    {
      command: `pnpm --filter @word/client exec vite --port ${CLIENT_PORT} --strictPort`,
      url: `http://localhost:${CLIENT_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { WORD_CLIENT_PORT: String(CLIENT_PORT), WORD_API_PORT: String(API_PORT) },
    },
  ],
});
