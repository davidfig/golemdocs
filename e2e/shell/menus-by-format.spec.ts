// The menu bar and toolbars show only what the open document's format can do.

import type { Page } from '@playwright/test';
import { expect, test, type App } from '../fixtures';
import { choose, menuRow, menuTitle, openMenu } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function importFile(app: App, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  const chooser = app.page.waitForEvent('filechooser');
  await choose(app, 'File', 'Import…');
  await (await chooser).setFiles(file);
}

const visibleTitles = (page: Page) => page.locator('[role=menubar] .wm-title:not([hidden])').allTextContents();

test('a Word document has the full set of menus (Picture only for pictures)', async ({ app, page }) => {
  await app.blank();
  expect(await visibleTitles(page)).toEqual(['File', 'Edit', 'View', 'Insert', 'Format', 'Tools', 'Table', 'Help', 'Admin']);
});

test('a plain-text file drops the menus and items it cannot use', async ({ app, page }) => {
  await app.blank();
  await importFile(app, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('plain words') });
  await expect.poll(() => app.text(), { timeout: 20_000 }).toBe('plain words');
  await expect(menuTitle(app, 'Table')).toBeHidden();
  await expect(menuTitle(app, 'Picture')).toBeHidden();
  await expect(menuTitle(app, 'File')).toBeVisible();
  await expect(menuTitle(app, 'Format')).toBeHidden();
  // The formatting toolbar has nothing for plain text.
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeHidden();
  await expect(app.toolbarButton('Bold')).toHaveCount(0);
});

test('a picture document shows the Picture menu and its toolbars instead of the text ones', async ({ app, page }) => {
  await app.blank();
  await importFile(app, { name: 'dot.png', mimeType: 'image/png', buffer: PNG });
  await expect(menuTitle(app, 'Picture')).toBeVisible({ timeout: 20_000 });
  await expect(menuTitle(app, 'Table')).toBeHidden();
  await expect(page.getByRole('toolbar', { name: 'Picture' })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Draw' })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeHidden();
  await openMenu(app, 'Picture');
  await expect(menuRow(page, 'Rotate Left')).toBeVisible();
  await expect(menuRow(page, 'Crop…')).toBeVisible();
});

test('the document format box names the open format', async ({ app, page }) => {
  await app.blank();
  const box = page.getByRole('combobox', { name: 'Document format' });
  await expect(box).toHaveValue(/Word Document/);
  await expect(menuTitle(app, 'Table')).toBeVisible();
});

test('View menu hides form modes for documents that are not PDFs', async ({ app, page }) => {
  await app.blank();
  await openMenu(app, 'View');
  await expect(menuRow(page, 'Fill In Form')).toHaveCount(0);
  await expect(menuRow(page, 'Edit PDF')).toHaveCount(0);
});
