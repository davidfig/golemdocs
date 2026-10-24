// File › Close: the open document is put away and nothing is open, until a document is made or opened.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { blankWith, menuContents, waitForOpen, waitForSaved } from './helpers';

const nothingOpen = (page: Page) => page.locator('.wm-nothing-open');

test('File › Close saves the document and leaves nothing open', async ({ app, page }) => {
  await blankWith(app, 'Kept when closed');
  await app.menu('File', 'Close');
  await expect(nothingOpen(page)).toBeVisible();
  await expect(nothingOpen(page)).toContainText('No document is open');
  await expect(page).toHaveTitle('Golem Docs');
  await expect(page).toHaveURL(/doc=none/);
  // Only what needs no document can be done: the document's own commands are off, Close too.
  const file = await menuContents(app, 'File');
  expect(file!.disabled).toEqual(expect.arrayContaining(['Close', 'Share…', 'Download', 'Rename…']));
  expect(file!.disabled).not.toContain('New');
  await expect(page.getByRole('combobox', { name: 'Document format' })).toBeDisabled();
  // Typing goes nowhere.
  await page.keyboard.type('lost');
  // The closed document was saved, and opens again from the Documents screen.
  await nothingOpen(page).getByRole('button', { name: 'Open…' }).click();
  await page.locator('.wm-dashboard article.wm-card').filter({ hasText: 'Document1' }).click();
  await waitForOpen(app, 'Document1');
  await expect(nothingOpen(page)).toBeHidden();
  expect(await app.text()).toBe('Kept when closed');
});

test('with nothing open, New makes a document, and a later visit carries on with nothing open', async ({ app, page }) => {
  await blankWith(app, 'First');
  await waitForSaved(page);
  await app.menu('File', 'Close');
  await expect(nothingOpen(page)).toBeVisible();
  // Coming back to the bare address: still nothing open, not the Welcome document.
  await page.goto('/');
  await app.ready();
  await expect(nothingOpen(page)).toBeVisible();
  await expect(page).toHaveTitle('Golem Docs');
  await nothingOpen(page).getByRole('button', { name: 'New Document' }).click();
  await waitForOpen(app, 'Document');
  await expect(nothingOpen(page)).toBeHidden();
  await app.type('Second');
  expect(await app.text()).toBe('Second');
});
