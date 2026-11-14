// The command palette's search also finds documents by title.

import type { Page } from '@playwright/test';
import { expect, test, type App } from './fixtures';
import { importFile, moveTo, text, waitForOpen, waitForSaved } from './helpers';

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' });
const search = (page: Page) => palette(page).getByRole('combobox', { name: 'Search commands and documents' });
const options = (page: Page) => palette(page).getByRole('option');
const option = (page: Page, label: string) => options(page).filter({ has: page.locator('.wm-palette-label', { hasText: new RegExp(`^${label}$`) }) });

async function openPalette(app: App): Promise<void> {
  await app.page.getByRole('button', { name: 'Command palette' }).click();
  await expect(search(app.page)).toBeFocused();
}

/** Saves two small documents, with the second left open. */
async function twoDocuments(app: App): Promise<void> {
  await app.goto('?doc=welcome');
  for (const file of [text('quarterly plan.txt', 'the plan'), text('zebra notes.md', '# zebras')]) {
    await importFile(app, file);
    await waitForSaved(app.page, file.name);
  }
}

test('a search finds documents by title, and Enter opens the one chosen', async ({ app, page }) => {
  await twoDocuments(app);
  await openPalette(app);
  // Not listed until something is searched for.
  await expect(option(page, 'quarterly plan.txt')).toHaveCount(0);
  await search(page).fill('plan quarterly');
  await expect(option(page, 'quarterly plan.txt')).toHaveCount(1);
  await expect(option(page, 'quarterly plan.txt').locator('.wm-file-icon')).toHaveCount(1);
  await expect(options(page).first()).toHaveClass(/active/);
  const recent = () => page.evaluate(() => localStorage.getItem('golemdocs.recentCommands'));
  const before = await recent();
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await waitForOpen(app, 'quarterly plan.txt');
  expect(await app.text()).toBe('the plan');
  // A document isn't a command: it doesn't join the recent ones.
  expect(await recent()).toBe(before);
});

test('clicking a document opens it', async ({ app, page }) => {
  await twoDocuments(app);
  await openPalette(app);
  await search(page).fill('quarterly');
  await option(page, 'quarterly plan.txt').click();
  await waitForOpen(app, 'quarterly plan.txt');
  expect(await app.text()).toBe('the plan');
});

test('documents are found by title alone, and commands still come first', async ({ app, page }) => {
  await twoDocuments(app);
  await openPalette(app);
  await search(page).fill('document');
  await expect(option(page, 'zebra notes.md')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await importFile(app, text('zoom meeting.txt', 'notes'));
  await waitForSaved(page, 'zoom meeting.txt');
  await openPalette(app);
  await search(page).fill('zoom');
  const labels = await options(page).locator('.wm-palette-label').allTextContents();
  expect(labels[0]).not.toBe('zoom meeting.txt');
  expect(labels).toContain('zoom meeting.txt');
});

test('choosing the document already open leaves it as it is', async ({ app, page }) => {
  await twoDocuments(app);
  await app.type('kept ');
  await openPalette(app);
  await search(page).fill('zebra');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await expect(app.editor).toBeFocused();
  await app.type('here');
  await expect.poll(() => app.text()).toBe('kept herezebras');
});

test('a document in a folder says which, so two of the same name can be told apart', async ({ app, page }) => {
  await twoDocuments(app);
  await app.menu('File', 'Open…');
  const dashboard = page.locator('.wm-dashboard');
  await dashboard.getByRole('button', { name: 'New folder', exact: true }).click();
  const field = dashboard.getByRole('textbox', { name: 'Folder name' });
  await field.fill('Reports');
  await field.press('Enter');
  const card = dashboard.locator('article.wm-card:not(.wm-folder)').filter({ hasText: 'quarterly plan.txt' });
  await card.hover();
  await card.getByRole('button', { name: 'Move…' }).click();
  await moveTo(page, 'Reports');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await app.goto('?doc=welcome'); // the palette's button is covered by the dashboard
  await openPalette(app);
  await search(page).fill('quarterly');
  await expect(option(page, 'quarterly plan.txt').locator('.wm-palette-meta')).toHaveText('Reports');
  await search(page).fill('zebra');
  await expect(option(page, 'zebra notes.md').locator('.wm-palette-meta')).toHaveText('');
});
