// A self-hosted server (docs/self-hosting.md) tells the page its own links and that it sells
// nothing (GET /api/site): the Help menu and the welcome document follow it, and File has no Subscribe.

import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { choose, openMenu } from './helpers';

const SITE = {
  links: { website: 'https://docs.example.org/', support: 'mailto:help@example.org', privacy: 'https://docs.example.org/privacy' },
  sells: false,
};
const selfHosted = (page: Page) => page.route('**/api/site', (route) => route.fulfill({ json: SITE }));
const fileMenu = async (app: Parameters<typeof openMenu>[0], page: Page) => {
  await openMenu(app, 'File');
  const labels = await page.locator('.wm-menu .wm-item span.label').allTextContents();
  await page.keyboard.press('Escape');
  return labels;
};

test('golemdocs.com offers the subscription in the File menu', async ({ app, page }) => {
  await app.blank();
  expect(await fileMenu(app, page)).toContain('Subscribe…');
});

test('a server that sells nothing has no Subscribe in the File menu', async ({ app, page }) => {
  await selfHosted(page);
  await app.blank();
  await expect.poll(() => fileMenu(app, page)).not.toContain('Subscribe…');
});

test('Help › Website and Privacy Policy open the server’s own pages; Terms stays built in', async ({ app, page, context }) => {
  await selfHosted(page);
  await context.route('https://docs.example.org/**', (route) => route.fulfill({ body: 'self-hosted', contentType: 'text/plain' }));
  await app.blank();

  let popup = context.waitForEvent('page');
  await choose(app, 'Help', 'Golem Docs Website');
  expect((await popup).url()).toBe('https://docs.example.org/');

  popup = context.waitForEvent('page');
  await choose(app, 'Help', 'Privacy Policy');
  expect((await popup).url()).toBe('https://docs.example.org/privacy');

  await choose(app, 'Help', 'Terms of Service');
  await expect.poll(() => app.text(), { timeout: 15_000 }).toMatch(/terms/i);
});

test('the welcome document gives the server’s support address', async ({ app, page }) => {
  await selfHosted(page);
  await app.goto('?doc=welcome');
  await expect(page).toHaveTitle('Welcome to Golem Docs - Golem Docs');
  await expect.poll(() => app.text(), { timeout: 15_000 }).toContain('help@example.org');
  expect(await app.text()).not.toContain('david@golemdocs.com');
});
