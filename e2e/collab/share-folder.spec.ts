// A shared folder (docs/folder-sharing.md): its public link and a person's view-only share open the folder's files in the viewer
// page (/view?pf=… and /view?f=…, src/viewer/folderPage.ts), with the files as a tree beside the document. A link from one file to
// another of the folder opens it in the same tab (Back goes back); a link to a document outside the folder goes nowhere. When the
// share ends, an open page clears.

import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { CLIENT_ORIGIN } from '../ports.ts';
import { clickTopLink, folderProject as project, newPerson, signedOutContext, unzip } from './helpers';

/** Changes through the API come from the site, as the app's do. */
const headers = { origin: CLIENT_ORIGIN };

/** The paths in a downloaded ZIP, sorted. */
const zipNames = (bytes: Buffer): string[] => Object.keys(unzip(bytes)).sort();

const tree = (page: Page) => page.getByRole('navigation', { name: 'Files' });

test('a folder’s public link shows its tree; links inside it open in the tab, and links out of it go nowhere', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  await owner.page.goto('/?doc=welcome');
  await owner.app.ready();
  const folderId = await project(owner.page);
  const made = await owner.page.request.put(`/api/folders/${folderId}/link`, { headers });
  expect(made.ok(), await made.text()).toBe(true);
  const { token } = (await made.json()) as { token: string };

  const stranger = await signedOutContext(browser);
  const page = await stranger.newPage();
  const response = await page.goto(`/view?pf=${token}`);
  expect(response?.status()).toBe(200);
  // No file named: the README at the top, and the address says so.
  await expect(page).toHaveTitle('README.md (view only) · Project');
  await expect(page).toHaveURL(/[?&]path=README\.md/);
  await expect(page.getByRole('heading', { name: 'Project' })).toBeVisible();
  await expect(tree(page).getByRole('link')).toHaveText(['Ideas.md', 'README.md']);
  await expect(tree(page).getByRole('link', { name: 'README.md' })).toHaveAttribute('aria-current', 'page');
  await expect(tree(page).getByText('Secret.md')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeVisible();

  // Download All: every file of the folder, in its folders, in one ZIP named for the folder; nothing from outside it.
  const [zip] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download All' }).click()]);
  expect(zip.suggestedFilename()).toBe('Project.zip');
  expect(zipNames(readFileSync((await zip.path())!))).toEqual(['Notes/Ideas.md', 'README.md']);
  await expect(page.getByRole('status').filter({ hasText: 'Downloaded 2 files' })).toBeVisible();

  // A link to a file of the folder: opened here, with its own address, and Back goes back.
  await clickTopLink(page);
  await expect(page).toHaveTitle('Ideas.md (view only) · Project');
  await expect(page).toHaveURL(/[?&]path=Notes%2FIdeas\.md/);
  await expect(tree(page).getByRole('link', { name: 'Ideas.md' })).toHaveAttribute('aria-current', 'page');

  // A link to a document outside the folder: said, and nothing opens.
  await clickTopLink(page);
  await expect(page.getByRole('status').filter({ hasText: 'outside this shared folder' })).toBeVisible();
  await expect(page).toHaveTitle('Ideas.md (view only) · Project');

  await page.goBack();
  await expect(page).toHaveTitle('README.md (view only) · Project');

  // A file from the tree, and nothing outside the folder can be asked for by path.
  await tree(page).getByRole('link', { name: 'Ideas.md' }).click();
  await expect(page).toHaveTitle('Ideas.md (view only) · Project');
  expect((await page.request.get(`/api/folder-public/${token}/file?path=../Secret.md`)).status()).toBe(404);
  const listed = await (await page.request.get(`/api/folder-public/${token}`)).json();
  expect(JSON.stringify(listed)).not.toContain(folderId);
  expect((await page.request.get(`/api/folder-public/${token}`)).headers()['x-robots-tag']).toContain('noindex');

  // Turned off: an open tab clears the next time it checks.
  expect((await owner.page.request.delete(`/api/folders/${folderId}/link`, { headers })).ok()).toBe(true);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('This link no longer works')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.wm-folder-tree')).toHaveCount(0);
  await owner.context.close();
  await stranger.close();
});

test('a folder\'s Share is in its right-click menu, both in File › Open and in the Files pane', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  const { page } = owner;
  await page.goto('/?doc=welcome');
  await owner.app.ready();
  await project(page);

  await owner.app.menu('File', 'Open…');
  const card = page.locator('.wm-dashboard article.wm-folder', { hasText: 'Project' });
  await card.click({ button: 'right' });
  const items = page.getByRole('menu').getByRole('menuitem');
  await expect(items.first()).toHaveText('Open folder');
  await expect(items.nth(1)).toHaveText('Share…');
  await page.getByRole('menuitem', { name: 'Share…' }).click();
  const dialog = page.locator('dialog.wm-share');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Project');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.keyboard.press('Escape');

  // This person's context starts with the app's own default, where a wide window already shows the pane.
  if (!(await page.locator('.wm-files').isVisible())) await owner.app.menu('View', 'Files Sidebar');
  const row = page.locator('.wm-files .wm-files-folder', { hasText: 'Project' });
  await row.click({ button: 'right' });
  await expect(page.getByRole('menu').getByRole('menuitem').nth(1)).toHaveText('Share…');
  await page.getByRole('menuitem', { name: 'Share…' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Project');
  await owner.context.close();
});

test('a person with a folder shared view-only opens it from Shared with me, and loses it when it is unshared', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  await owner.page.goto('/?doc=welcome');
  await owner.app.ready();
  const folderId = await project(owner.page);
  const reader = await newPerson(browser, 'reader');
  const shared = await owner.page.request.put(`/api/folders/${folderId}/shares`, { data: { email: reader.email, role: 'viewer' }, headers });
  expect(shared.ok(), await shared.text()).toBe(true);

  await reader.page.goto('/?doc=welcome');
  await reader.app.ready();
  await reader.app.menu('File', 'Open…');
  const dashboard = reader.page.locator('.wm-dashboard');
  await dashboard.getByRole('button', { name: 'Open folder Project' }).click();
  await dashboard.getByRole('button', { name: 'Open README.md' }).click();
  await expect(reader.page).toHaveURL(/\/view\?f=[\w-]+&path=README\.md/);
  await expect(reader.page).toHaveTitle('README.md (view only) · Project');
  await expect(tree(reader.page).getByRole('link')).toHaveText(['Ideas.md', 'README.md']);
  await clickTopLink(reader.page);
  await expect(reader.page).toHaveTitle('Ideas.md (view only) · Project');
  // A person's view-only share downloads too: the file shown, and the whole folder.
  const [one] = await Promise.all([reader.page.waitForEvent('download'), reader.page.getByRole('button', { name: 'Download', exact: true }).click()]);
  expect(one.suggestedFilename()).toBe('Ideas.md');
  const [zip] = await Promise.all([reader.page.waitForEvent('download'), reader.page.getByRole('button', { name: 'Download All' }).click()]);
  expect(zipNames(readFileSync((await zip.path())!))).toEqual(['Notes/Ideas.md', 'README.md']);

  const people = (await (await owner.page.request.get(`/api/folders/${folderId}/shares`)).json()) as { userId: string }[];
  expect((await owner.page.request.delete(`/api/folders/${folderId}/shares/${people[0]!.userId}`, { headers })).ok()).toBe(true);
  await reader.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(reader.page.getByText('This folder isn’t shared with you any more.')).toBeVisible({ timeout: 15_000 });
  await owner.context.close();
  await reader.context.close();
});
