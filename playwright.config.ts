// End-to-end tests: the real app in Chromium, against its own client and server (never the ones
// `pnpm dev` runs on :5173 and :3001). The server is wrangler's fully simulated local mode on a
// throwaway state folder, so no test touches real Cloudflare resources.
//
//   pnpm e2e            run everything (scripts/e2e.ts: shards with their own servers, then the @heavy tests in a second, quieter pass)
//   pnpm e2e:rest       run only what the last run did not pass
//   pnpm e2e --ui       watch mode with the Playwright UI (arguments go straight to Playwright)
//
// Billing and the assistant (Clip) are deliberately not covered yet.

import os from 'node:os';
import { defineConfig, devices } from '@playwright/test';
import { API_PORT, CLIENT_PORT, STATE } from './e2e/ports.ts';

// GPU rendering needs a real display stack: a Mac outside CI. E2E_SOFTWARE_GL=1 forces software.
const GPU = process.platform === 'darwin' && !process.env.CI && !process.env.E2E_SOFTWARE_GL;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'e2e/.results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry: a test that only passes on it is reported as flaky, not hidden, and load rarely fails the same test twice.
  retries: 1,
  // A third of the cores (Playwright's default is half): each test runs a full WebGL page, and a busier machine is what made tests that pass alone fail in a full run. E2E_WORKERS overrides it.
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : process.env.CI ? 2 : Math.max(2, Math.floor(os.cpus().length / 3)),
  timeout: 60_000,
  // A run that has not ended by now is stopped, with the tests that did not report left to `pnpm e2e:rest`, instead of hanging for ever. The runner also stops a run that prints nothing for a while (E2E_IDLE_MS).
  globalTimeout: Number(process.env.E2E_GLOBAL_TIMEOUT_MS ?? 40 * 60_000),
  expect: { timeout: 10_000 },
  // The progress reporter writes how each test ended, for `pnpm e2e:rest` (it does nothing without E2E_PROGRESS).
  reporter: process.env.CI
    ? [['list'], ['./e2e/progress-reporter.ts'], ['html', { open: 'never', outputFolder: 'e2e/.report' }]]
    : [['list'], ['./e2e/progress-reporter.ts']],
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
        `rm -rf ${STATE} && mkdir -p client/dist server/.no-assets && cd server && ` +
        `pnpm exec wrangler d1 migrations apply DIRECTORY --env local --local --persist-to ../${STATE} && ` +
        `exec ./node_modules/.bin/wrangler dev --env local --port ${API_PORT} --inspector-port ${API_PORT + 6000} --persist-to ../${STATE} --var DEV_USER:e2e@example.com ` +
        // Fake Google credentials, so the sign-in tests do not depend on a developer's own .dev.vars.
        `--var GOOGLE_CLIENT_ID:e2e-google-client --var GOOGLE_CLIENT_SECRET:e2e-google-secret`,
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
    },
    {
      // `exec`, and not `pnpm exec`: pnpm starts the server in a process group of its own, which Playwright's shutdown does not kill, and the server then keeps Playwright from ever exiting.
      command: `cd client && exec ./node_modules/.bin/vite --port ${CLIENT_PORT} --strictPort`,
      url: `http://localhost:${CLIENT_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { WORD_CLIENT_PORT: String(CLIENT_PORT), WORD_API_PORT: String(API_PORT) },
    },
  ],
});
