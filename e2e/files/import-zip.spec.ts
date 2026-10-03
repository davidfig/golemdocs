// File ▸ Import of a ZIP: its folders are made (or reused), and what is already saved is only overwritten when asked.

import type { Locator, Page } from '@playwright/test';
import { expect, test, type App } from './fixtures';
import { buildZip, status, type Upload } from './helpers';

const dashboard = (page: Page) => page.locator('.wm-dashboard');
const cards = (page: Page) => dashboard(page).locator('article.wm-card:not(.wm-folder)');
const folders = (page: Page) => dashboard(page).locator('article.wm-folder');
const names = (locator: Locator) => locator.locator('.wm-card-name').allTextContents();
async function expectNames(locator: Locator, expected: string[]): Promise<void> {
  await expect.poll(async () => (await names(locator)).sort()).toEqual([...expected].sort());
}

const archive: Upload = {
  name: 'bundle.zip',
  mimeType: 'application/zip',
  buffer: buildZip([
    { name: 'top.txt', data: 'at the top' },
    { name: 'Work/', data: '' },
    { name: 'Work/plan.md', data: '# plan' },
    { name: 'Work/Reports/q1.txt', data: 'quarter one' },
    { name: '__MACOSX/Work/._plan.md', data: 'junk' },
  ]),
};

/** The same files with other contents, so each one is a duplicate to ask about. */
const changed: Upload = {
  ...archive,
  buffer: buildZip([
    { name: 'top.txt', data: 'at the top, changed' },
    { name: 'Work/', data: '' },
    { name: 'Work/plan.md', data: '# plan, changed' },
    { name: 'Work/Reports/q1.txt', data: 'quarter one, changed' },
  ]),
};

async function importZip(app: App, zip: Upload, message: string): Promise<void> {
  const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), app.menu('File', 'Import…')]);
  await chooser.setFiles({ name: zip.name, mimeType: zip.mimeType!, buffer: zip.buffer });
  await expect.poll(() => status(app.page)).toBe(message);
}

async function openDashboard(app: App): Promise<void> {
  await app.menu('File', 'Open…');
  await expect(dashboard(app.page).getByRole('searchbox', { name: 'Search documents' })).toBeFocused();
}

test('a ZIP is imported into the same folders, and importing it again skips what is identical and can keep both of what differs', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importZip(app, archive, 'Imported documents: 3');
  await openDashboard(app);
  await expectNames(cards(page), ['top.txt']);
  await expectNames(folders(page), ['Work']);

  await folders(page).filter({ hasText: 'Work' }).getByRole('button', { name: 'Open folder Work' }).click();
  await expectNames(cards(page), ['plan.md']);
  await expectNames(folders(page), ['Reports']);
  await folders(page).filter({ hasText: 'Reports' }).getByRole('button', { name: 'Open folder Reports' }).click();
  await expectNames(cards(page), ['q1.txt']);

  // Again, unchanged: nothing is asked and nothing is added.
  await dashboard(page).getByRole('navigation').getByRole('button', { name: 'Documents' }).click();
  await page.keyboard.press('Escape');
  await importZip(app, archive, 'Imported documents: 0. Left as they were (identical, or skipped): 3');

  // Again, with other contents: the folders are reused, and keeping both numbers each document.
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.menu('File', 'Import…')]);
  await chooser.setFiles({ name: changed.name, mimeType: changed.mimeType!, buffer: changed.buffer });
  const ask = page.locator('dialog.wm-dialog', { hasText: 'Name already in use' });
  await ask.getByLabel('Do this for all remaining duplicates').check();
  await ask.getByRole('button', { name: 'Keep both' }).click();
  await expect.poll(() => status(page)).toBe('Imported documents: 3');
  await openDashboard(app);
  await expectNames(cards(page), ['top.txt', 'top (2).txt']);
  await expectNames(folders(page), ['Work']);
  await folders(page).filter({ hasText: 'Work' }).getByRole('button', { name: 'Open folder Work' }).click();
  await expectNames(cards(page), ['plan.md', 'plan (2).md']);
  await expectNames(folders(page), ['Reports']);
});
