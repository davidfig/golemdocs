// File ▸ Open: the documents dashboard (every document saved in this browser, as thumbnails).

import type { Locator, Page } from '@playwright/test';
import { MOD, expect, test, type App } from './fixtures';
import { formatLabel, importFile, status, text, waitForOpen, waitForSaved } from './helpers';

const dashboard = (page: Page) => page.locator('.wm-dashboard');
const cards = (page: Page) => dashboard(page).locator('article.wm-card');
const cardNames = (page: Page) => cards(page).locator('.wm-card-name').allTextContents();

/** A card's Delete button (shown once the card is pointed at). */
async function pressDelete(card: Locator): Promise<void> {
  await card.hover();
  await card.getByRole('button', { name: 'Delete' }).click();
}

/** Opens the dashboard and waits until it is ready for the keyboard (the search box has the focus). */
async function openDashboard(app: App): Promise<void> {
  await app.menu('File', 'Open…');
  await expect(dashboard(app.page).getByRole('searchbox', { name: 'Search documents' })).toBeFocused();
}

/** Imports three small documents, one after the other, so each is saved. */
async function saveThree(app: App): Promise<void> {
  await app.goto('?doc=welcome');
  for (const file of [text('alpha.txt', 'the first'), text('beta.md', '# second'), text('gamma.csv', 'a,b\n1,2\n')]) {
    await importFile(app, file);
    await waitForSaved(app.page, file.name);
  }
}

test('with nothing saved, the dashboard says so and offers a blank document and an import', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await app.menu('File', 'Open…');
  await expect(dashboard(page)).toBeVisible();
  await expect(dashboard(page).getByRole('heading', { name: 'Documents' })).toBeVisible();
  await expect(dashboard(page).getByText('Documents you save will show up here.')).toBeVisible();
  await expect(dashboard(page).getByText('Saved in this browser')).toBeVisible();
  await expect(dashboard(page).getByRole('button', { name: 'New document' })).toBeVisible();
  await expect(dashboard(page).getByRole('button', { name: 'Import a file from this computer' })).toBeVisible();
  await expect(dashboard(page).getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
});

test('saved documents appear as cards, newest first, with their size and age', async ({ app, page }) => {
  await saveThree(app);
  await app.menu('File', 'Open…');
  await expect(cards(page)).toHaveCount(3);
  expect(await cardNames(page)).toEqual(['gamma.csv', 'beta.md', 'alpha.txt']);
  await expect(cards(page).first().locator('.wm-card-meta')).toHaveText(/Just now|\d+ (seconds?|minutes?) ago|< 1 KB|\d+ B|\d+(\.\d)? KB/);
  await expect(dashboard(page).getByText('Documents you save will show up here.')).toHaveCount(0);
});

test('every card shows a thumbnail of its first page', async ({ app, page }) => {
  await saveThree(app);
  await app.menu('File', 'Open…');
  const images = dashboard(page).locator('.wm-thumb img');
  await expect(images).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    const loaded = await images.nth(i).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0 && img.src.startsWith('blob:'));
    expect(loaded).toBe(true);
  }
});

test('clicking a card opens that document and closes the dashboard', async ({ app, page }) => {
  await saveThree(app);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open beta.md' }).click();
  await expect(dashboard(page)).toBeHidden();
  await waitForOpen(app, 'beta.md');
  expect(await formatLabel(page)).toBe('Markdown');
  expect(await app.text()).toBe('second');
  await expect(page).toHaveTitle('beta.md - Golem Docs');
  await expect.poll(() => page.url()).toContain('doc=local%3A');
});

test('the search box filters the cards by name', async ({ app, page }) => {
  await saveThree(app);
  await app.menu('File', 'Open…');
  const search = dashboard(page).getByRole('searchbox', { name: 'Search documents' });
  await expect(search).toBeFocused();
  await search.fill('et');
  await expect(cards(page)).toHaveCount(1);
  expect(await cardNames(page)).toEqual(['beta.md']);
  await search.fill('nothing like this');
  await expect(cards(page)).toHaveCount(0);
  await expect(dashboard(page).getByText('No documents match your search.')).toBeVisible();
  await search.fill('');
  await expect(cards(page)).toHaveCount(3);
});

test('deleting asks in a dialog listing the document, and then it is gone for good', async ({ app, page }) => {
  await saveThree(app);
  await app.menu('File', 'Open…');
  const beta = cards(page).filter({ hasText: 'beta.md' });
  await pressDelete(beta);
  // The button only asks.
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.locator('.wm-delete-list li')).toHaveText(['beta.md']);
  await expect(cards(page)).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(cards(page)).toHaveCount(2);
  expect(await cardNames(page)).toEqual(['gamma.csv', 'alpha.txt']);
  // Open Recent no longer lists it either.
  await page.keyboard.press('Escape');
  await app.menubar.getByRole('menuitem', { name: /^File$/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /^Open Recent/ }).click();
  const recent = (await page.getByRole('menu').last().getByRole('menuitem').allTextContents()).map((s) => s.trim());
  expect(recent).toEqual(expect.arrayContaining(['alpha.txt', 'gamma.csv']));
  expect(recent).not.toContain('beta.md');
});

test('cancelling the delete dialog keeps the document', async ({ app, page }) => {
  await saveThree(app);
  await app.menu('File', 'Open…');
  await pressDelete(cards(page).filter({ hasText: 'beta.md' }));
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(cards(page)).toHaveCount(3);
});

test('deleting the open document opens the Welcome document, and deleting another one does not', async ({ app, page }) => {
  await saveThree(app);
  // gamma.csv is the open document: deleting alpha.txt leaves it alone.
  await app.menu('File', 'Open…');
  await pressDelete(cards(page).filter({ hasText: 'alpha.txt' }));
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(cards(page)).toHaveCount(2);
  await expect(page).toHaveURL(/doc=local/);
  await expect(page).not.toHaveTitle('Welcome to Golem Docs - Golem Docs');
  // Deleting the open one falls back to Welcome, and the URL no longer names the deleted document.
  await pressDelete(cards(page).filter({ hasText: 'gamma.csv' }));
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveTitle('Welcome to Golem Docs - Golem Docs');
  await expect(page).toHaveURL(/\/welcome$/);
  // The Documents screen stays up, with Welcome open behind it; it is built in, so nothing new was saved.
  expect(await cardNames(page)).toEqual(['beta.md']);
});

test('the blank document tile starts a new document', async ({ app, page }) => {
  await saveThree(app);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'New document' }).click();
  await expect(dashboard(page)).toBeHidden();
  await waitForOpen(app, 'Document1');
  expect(await formatLabel(page)).toBe('Word Document');
  expect(await app.text()).toBe('');
});

test('the import tile opens the file chooser, and the file opens over the dashboard', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await app.menu('File', 'Open…');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), dashboard(page).getByRole('button', { name: 'Import a file from this computer' }).click()]);
  await chooser.setFiles({ name: 'tile.md', mimeType: 'text/markdown', buffer: Buffer.from('# From tile') });
  await waitForOpen(app, 'tile.md');
  await expect(dashboard(page)).toBeHidden();
  expect(await app.text()).toBe('From tile');
});

test('the dashboard closes with Escape and with the close button, and Ctrl+O shows it', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await page.keyboard.press(`${MOD}+o`);
  await expect(dashboard(page).getByRole('searchbox', { name: 'Search documents' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dashboard(page)).toBeHidden();
  await openDashboard(app);
  await dashboard(page).getByRole('button', { name: 'Close' }).click();
  await expect(dashboard(page)).toBeHidden();
  // The keyboard goes back to the document.
  await app.type('x');
  expect(await status(page)).not.toBe('');
});

test('closing the dashboard leaves the open document as it was', async ({ app, page }) => {
  await app.blank();
  await app.type('still here');
  await openDashboard(app);
  await page.keyboard.press('Escape');
  await expect(dashboard(page)).toBeHidden();
  await app.type('!');
  expect(await app.text()).toBe('still here!');
});
