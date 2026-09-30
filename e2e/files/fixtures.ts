// The fixtures for the files specs: the shared ones, with nobody signed in. The test server signs
// every browser in as a development user, whose account (shared by every test and every run) would
// put other tests' documents in the dashboard. These specs are about what a guest does: documents
// live in this browser only.

import { test as base, expect, MOD, App } from '../fixtures';

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: null }) }));
    await use(page);
  },
});

export { expect, MOD, App };
