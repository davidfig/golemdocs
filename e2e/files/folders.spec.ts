// The dashboard's folders: making, naming, opening, moving into (menu and drag), deleting.

import type { Locator, Page } from '@playwright/test';
import { expect, test, type App } from './fixtures';
import { importFile, text, waitForSaved } from './helpers';

const dashboard = (page: Page) => page.locator('.wm-dashboard');
const cards = (page: Page) => dashboard(page).locator('article.wm-card:not(.wm-folder)');
const folders = (page: Page) => dashboard(page).locator('article.wm-folder');
const names = (locator: Locator) => locator.locator('.wm-card-name').allTextContents();
/** The names shown, in any order, once the dashboard has caught up with what was just done. */
async function expectNames(locator: Locator, expected: string[]): Promise<void> {
  await expect.poll(async () => (await names(locator)).sort()).toEqual([...expected].sort());
}
const card = (page: Page, name: string) => cards(page).filter({ hasText: name });
const folder = (page: Page, name: string) => folders(page).filter({ hasText: name });

async function openDashboard(app: App): Promise<void> {
  await app.menu('File', 'Open…');
  await expect(dashboard(app.page).getByRole('searchbox', { name: 'Search documents' })).toBeFocused();
}

/** Makes a folder in the current place and names it. */
async function makeFolder(page: Page, name: string): Promise<void> {
  await dashboard(page).getByRole('button', { name: 'New folder', exact: true }).click();
  const field = dashboard(page).getByRole('textbox', { name: 'Folder name' });
  await expect(field).toBeFocused();
  await field.fill(name);
  await field.press('Enter');
  await expect(folder(page, name)).toHaveCount(1);
}

/** Saves two small documents and opens the dashboard. */
async function twoDocuments(app: App): Promise<void> {
  await app.goto('?doc=welcome');
  for (const file of [text('alpha.txt', 'the first'), text('beta.md', '# second')]) {
    await importFile(app, file);
    await waitForSaved(app.page, file.name);
  }
  await openDashboard(app);
}

test('a new folder is named where it is made, and survives a reload', async ({ app, page }) => {
  await twoDocuments(app);
  await makeFolder(page, 'Reports');
  await expectNames(folders(page), ['Reports']);
  await expect(folder(page, 'Reports').locator('.wm-card-meta')).toHaveText('0 items');

  await page.reload();
  await openDashboard(app);
  await expectNames(folders(page), ['Reports']);
});

test('Move… files a document in a folder, which opens to show it, with a way back', async ({ app, page }) => {
  await twoDocuments(app);
  await makeFolder(page, 'Reports');
  await card(page, 'alpha.txt').hover();
  await card(page, 'alpha.txt').getByRole('button', { name: 'Move…' }).click();
  await dashboard(page).getByRole('dialog').getByRole('button', { name: 'Reports' }).click();

  await expectNames(cards(page), ['beta.md']);
  await expect(folder(page, 'Reports').locator('.wm-card-meta')).toHaveText('1 item');

  await folder(page, 'Reports').getByRole('button', { name: 'Open folder Reports' }).click();
  await expectNames(cards(page), ['alpha.txt']);
  await expect(dashboard(page).getByRole('navigation', { name: 'Location' })).toContainText('Reports');

  await dashboard(page).getByRole('navigation').getByRole('button', { name: 'Documents' }).click();
  await expectNames(cards(page), ['beta.md']);
});

test('dragging a card onto a folder, and onto a breadcrumb, moves it', async ({ app, page }) => {
  await twoDocuments(app);
  await makeFolder(page, 'Reports');
  await card(page, 'beta.md').dragTo(folder(page, 'Reports'));
  await expectNames(cards(page), ['alpha.txt']);

  await folder(page, 'Reports').getByRole('button', { name: 'Open folder Reports' }).click();
  await expectNames(cards(page), ['beta.md']);
  await card(page, 'beta.md').dragTo(dashboard(page).getByRole('navigation').getByRole('button', { name: 'Documents' }));
  await expect(cards(page)).toHaveCount(0);
  await dashboard(page).getByRole('navigation').getByRole('button', { name: 'Documents' }).click();
  await expectNames(cards(page), ['alpha.txt', 'beta.md']);
});

test('folders nest, can be renamed, and cannot be moved into themselves', async ({ app, page }) => {
  await twoDocuments(app);
  await makeFolder(page, 'Outer');
  await folder(page, 'Outer').getByRole('button', { name: 'Open folder Outer' }).click();
  await makeFolder(page, 'Inner');
  await expect(dashboard(page).getByRole('navigation')).toContainText('Outer');

  await folder(page, 'Inner').hover();
  await folder(page, 'Inner').getByRole('button', { name: 'Rename' }).click();
  const field = dashboard(page).getByRole('textbox', { name: 'Folder name' });
  await field.fill('Deeper');
  await field.press('Enter');
  await expectNames(folders(page), ['Deeper']);

  // Outer can't go in Deeper, which is inside it: the picker doesn't offer it.
  await dashboard(page).getByRole('navigation').getByRole('button', { name: 'Documents' }).click();
  await folder(page, 'Outer').hover();
  await folder(page, 'Outer').getByRole('button', { name: 'Move…' }).click();
  const picker = dashboard(page).getByRole('dialog');
  await expect(picker.getByRole('button', { name: 'Deeper' })).toHaveCount(0);
  await picker.getByRole('button', { name: 'Cancel' }).click();
  await expect(picker).toHaveCount(0);
});

test('deleting a folder deletes what was in it', async ({ app, page }) => {
  await twoDocuments(app);
  await makeFolder(page, 'Reports');
  await card(page, 'alpha.txt').dragTo(folder(page, 'Reports'));
  await expect(cards(page)).toHaveCount(1);

  await folder(page, 'Reports').hover();
  await folder(page, 'Reports').getByRole('button', { name: 'Delete folder' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.locator('.wm-delete-list li')).toHaveText(['Reports/', 'Reports/alpha.txt']);
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(folders(page)).toHaveCount(0);
  // What was in the folder went with it.
  await expectNames(cards(page), ['beta.md']);
});

test('searching looks in every folder', async ({ app, page }) => {
  await twoDocuments(app);
  await makeFolder(page, 'Reports');
  await card(page, 'alpha.txt').dragTo(folder(page, 'Reports'));
  await expect(cards(page)).toHaveCount(1);

  await dashboard(page).getByRole('searchbox').fill('alpha');
  await expectNames(cards(page), ['alpha.txt']);
  await dashboard(page).getByRole('searchbox').fill('');
  await expectNames(cards(page), ['beta.md']);
});

test('a document made from inside a folder is filed there', async ({ app, page }) => {
  await twoDocuments(app);
  await makeFolder(page, 'Reports');
  await folder(page, 'Reports').getByRole('button', { name: 'Open folder Reports' }).click();
  await dashboard(page).getByRole('button', { name: 'New document' }).click();
  await app.page.keyboard.type('hello');
  await waitForSaved(page, 'Document1.docx');
  await openDashboard(app);
  // The Documents screen opens in the folder of the open document.
  await expectNames(cards(page), ['Document1.docx']);
  await dashboard(page).getByRole('navigation').getByRole('button', { name: 'Documents' }).click();
  await expect(folder(page, 'Reports').locator('.wm-card-meta')).toHaveText('1 item');
});
