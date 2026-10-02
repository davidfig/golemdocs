// The documents that ship with the app (welcome, What's New, privacy policy, terms, the samples),
// their addresses, and how the address bar picks what opens.

import { expect, test } from './fixtures';
import { formatLabel, menuContents, waitForOpen } from './helpers';

test('?doc=privacy opens the privacy policy', async ({ app, page }) => {
  await app.goto('?doc=privacy');
  await expect(page).toHaveTitle('Privacy Policy - Golem Docs');
  expect(await app.text()).toContain('Golem Docs - Privacy Policy');
  expect(await formatLabel(page)).toBe('Word Document');
});

test('?doc=terms opens the terms of service', async ({ app, page }) => {
  await app.goto('?doc=terms');
  await expect(page).toHaveTitle('Terms of Service - Golem Docs');
  expect(await app.text()).toContain('Golem Docs - Terms of Service');
});

test('?doc=changelog opens What’s New, at its own address', async ({ app, page }) => {
  await app.goto('?doc=changelog');
  await expect(page).toHaveTitle('What’s New in Golem Docs - Golem Docs');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/changelog');
  // Select All can land before the text has been laid out.
  await expect.poll(() => app.text()).toMatch(/^\s*What’s New in Golem Docs\n/);
  expect(await app.text()).toMatch(/\d+\.\d+\.\d+ - /);
});

test('the /changelog and /welcome paths open those documents directly', async ({ app, page }) => {
  await page.goto('/changelog');
  await app.ready();
  await expect(page).toHaveTitle('What’s New in Golem Docs - Golem Docs');
  await page.goto('/welcome');
  await app.ready();
  await expect(page).toHaveTitle('Welcome to Golem Docs - Golem Docs');
  expect(await app.text()).toContain('A document editor that lives in your browser');
});

test('the privacy and terms paths lead to the plain pages of the site', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page).toHaveTitle(/Privacy Policy/);
  await page.goto('/terms');
  await expect(page).toHaveTitle(/Terms of Service/);
});

test('?doc=fonts opens the fonts sample and ?doc=welcome the welcome text', async ({ app, page }) => {
  await app.goto('?doc=fonts');
  await expect(page).toHaveTitle('Fonts - Golem Docs');
  expect(await app.text()).toContain('Calibri');
  await app.goto('?doc=welcome');
  await expect(page).toHaveTitle('Welcome to Golem Docs - Golem Docs');
});

test('?doc=war-and-peace opens the long sample book as plain text', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?doc=war-and-peace');
  await page.waitForFunction(() => (window as unknown as { loaded: boolean }).loaded === true, null, { timeout: 100_000 });
  await expect(page).toHaveTitle('War and Peace - Golem Docs');
  expect(await formatLabel(page)).toBe('Word Document');
  await expect.poll(() => page.evaluate(() => (window as unknown as { pages: unknown[] }).pages.length)).toBeGreaterThan(50);
});

test('Help ▸ What’s New, About, Privacy Policy and Terms of Service open their documents', async ({ app, page }) => {
  await app.goto('?doc=fonts');
  await app.menu('Help', 'What’s New');
  await waitForOpen(app, 'What’s New in Golem Docs');
  await expect(page).toHaveTitle('What’s New in Golem Docs - Golem Docs');
  await app.menu('Help', 'About Golem Docs');
  await waitForOpen(app, 'Welcome to Golem Docs');
  await app.menu('Help', 'Privacy Policy');
  await waitForOpen(app, 'Privacy Policy');
  expect(await app.text()).toContain('Privacy Policy');
  await app.menu('Help', 'Terms of Service');
  await waitForOpen(app, 'Terms of Service');
  expect(await app.text()).toContain('Terms of Service');
});

test('the built-in documents are not saved until they are edited', async ({ app, page }) => {
  await app.goto('?doc=privacy');
  await app.menu('Help', 'What’s New');
  await waitForOpen(app, 'What’s New in Golem Docs');
  await app.menu('File', 'Open…');
  await expect(page.locator('.wm-dashboard article.wm-card')).toHaveCount(0);
  await expect(page.getByText('Documents you save will show up here.')).toBeVisible();
});

test('an edited built-in document is saved as a document of its own', async ({ app, page }) => {
  await app.goto('?doc=terms');
  await app.focus();
  await page.keyboard.press('ControlOrMeta+Home');
  await app.type('Annotated ');
  await expect.poll(() => page.url(), { timeout: 15_000 }).toContain('doc=local%3A');
  await page.reload();
  await app.ready();
  expect(await app.text()).toContain('Annotated');
});

test('a guest’s Admin menu holds only Open Sample (the admin tools are left out)', async ({ app }) => {
  await app.goto('?doc=welcome');
  expect((await menuContents(app, 'Admin'))?.items).toEqual(['Open Sample']);
});

test('Open Sample opens each sample: Welcome, Fonts and War and Peace', async ({ app, page }) => {
  test.setTimeout(120_000);
  await app.goto('?doc=privacy');
  await app.menu('Admin', 'Open Sample', 'Fonts');
  await waitForOpen(app, 'Fonts');
  expect(await app.text()).toContain('Calibri');
  await app.menu('Admin', 'Open Sample', 'Welcome to Golem Docs');
  await waitForOpen(app, 'Welcome to Golem Docs');
  expect(await app.text()).toContain('A document editor that lives in your browser');
  await app.menu('Admin', 'Open Sample', 'War and Peace');
  await waitForOpen(app, 'War and Peace');
  await expect(page).toHaveTitle('War and Peace - Golem Docs');
  expect(await app.text()).toContain('The Project Gutenberg eBook of War and Peace');
});

test('an unknown ?doc= opens the fonts sample and leaves a usable editor', async ({ app, page }) => {
  await page.goto('/?doc=nonsense');
  await app.ready();
  await expect(page).toHaveTitle('Fonts - Golem Docs');
  await expect(app.menubar).toBeVisible();
});
