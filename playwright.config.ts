// End-to-end tests: the real app in Chromium, against its own client and server (never the ones
// `pnpm dev` runs on :5173 and :3001). The server is wrangler's fully simulated local mode on a
// throwaway state folder, so no test touches real Cloudflare resources.
//
//   pnpm e2e            run everything (scripts/e2e.ts: the @heavy tests get a second, quieter pass)
//   pnpm e2e --ui       watch mode with the Playwright UI (arguments go straight to Playwright)
//
// Billing and the assistant (Clip) are deliberately not covered yet.

import { defineConfig, devices } from '@playwright/test';

const CLIENT_PORT = 5273;
const API_PORT = 3101;
const STATE = '../e2e/.state';
// GPU rendering needs a real display stack: a Mac outside CI. E2E_SOFTWARE_GL=1 forces software.
const GPU = process.platform === 'darwin' && !process.env.CI && !process.env.E2E_SOFTWARE_GL;

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
    // WebGL must work headless. On a Mac use the GPU through Metal (far faster than software
    // rendering, which saturates the CPU); elsewhere, notably CI, fall back to software.
    launchOptions: {
      args: GPU
        ? ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
        : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    {
      name: 'chromium',
      // The full Chromium in new headless mode can use the GPU; the default headless shell cannot.
      use: { ...devices['Desktop Chrome'], ...(GPU ? { channel: 'chromium' as const } : {}), viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: [
    {
      // Fresh database and storage every run, then the Worker (API and collaboration rooms).
      command:
        `rm -rf e2e/.state && mkdir -p client/dist && cd server && ` +
        `pnpm exec wrangler d1 migrations apply DIRECTORY --env local --local --persist-to ${STATE} && ` +
        `pnpm exec wrangler dev --env local --port ${API_PORT} --persist-to ${STATE} --var DEV_USER:e2e@example.com ` +
        // Fake Google credentials, so the sign-in tests do not depend on a developer's own .dev.vars.
        `--var GOOGLE_CLIENT_ID:e2e-google-client --var GOOGLE_CLIENT_SECRET:e2e-google-secret`,
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
    },
    {
      command: `pnpm --filter @golemdocs/client exec vite --port ${CLIENT_PORT} --strictPort`,
      url: `http://localhost:${CLIENT_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { WORD_CLIENT_PORT: String(CLIENT_PORT), WORD_API_PORT: String(API_PORT) },
    },
  ],
});
