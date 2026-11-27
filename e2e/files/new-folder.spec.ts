// New folders in the Files sidebar: the bar's New Folder button and File › New Folder start one, ready to be named, in the folder of
// the row last picked (or at the top level); the desktop app gives it ⇧⌘N (a browser keeps that key for a private window); and the
// right-click menus put New Folder with the new documents, ahead of Import.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { menuRow, openMenu } from '../shell/helpers';
import { vaultShell } from '../shell/vaultShell';

const panel = (page: Page) => page.locator('.wm-files');
const folderRow = (page: Page, name: string) => panel(page).locator('.wm-files-folder', { hasText: name });

async function name(page: Page, text: string): Promise<void> {
  const field = page.locator('.wm-files-rename');
  await expect(field).toBeFocused();
  await field.fill(text);
  await page.keyboard.press('Enter');
  await expect(folderRow(page, text)).toHaveCount(1);
}

test('the bar’s button makes a folder at the top level, then inside the folder picked', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await app.menu('View', 'Files Sidebar');
  const button = panel(page).locator('.wm-files-bar').getByRole('button', { name: 'New folder' });
  await expect(button).toBeVisible();

  await button.click();
  await name(page, 'Projects');
  await expect(folderRow(page, 'Projects')).toHaveAttribute('aria-level', '1');

  // Picking the folder (by the keyboard here) makes the next one go inside it, and it opens to show it.
  await folderRow(page, 'Projects').focus();
  await button.click();
  await name(page, 'Drafts');
  await expect(folderRow(page, 'Drafts')).toHaveAttribute('aria-level', '2');
  await expect(folderRow(page, 'Projects')).toHaveAttribute('aria-expanded', 'true');
});

test('File › New Folder opens the sidebar when it is shut, and a browser shows no key for it', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await expect(panel(page)).toBeHidden();
  await openMenu(app, 'File');
  await expect(menuRow(page, 'New Folder').locator('.wm-shortcut').filter({ hasText: /\S/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await app.menu('File', 'New Folder');
  await expect(panel(page)).toBeVisible();
  await name(page, 'Inbox');
});

test('right-click menus put New folder with the new documents, ahead of Import', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await app.menu('View', 'Files Sidebar');
  await panel(page).locator('.wm-files-tree').click({ button: 'right', position: { x: 100, y: 300 } });
  const labels = await page.getByRole('menu').getByRole('menuitem').allTextContents();
  const at = (label: string) => labels.findIndex((l) => l.startsWith(label));
  expect(at('New folder')).toBeGreaterThan(-1);
  expect(at('New folder')).toBeLessThan(at('Import'));
  expect(labels[at('Import') - 1]).toMatch(/^New folder/);
});

test('in the desktop app ⇧⌘N makes a folder from the document, and the menu shows the key', async ({ app, page }) => {
  await vaultShell(page, { 'notes.md': '# Notes\n' });
  await app.goto('?doc=welcome');
  await openMenu(app, 'File');
  await expect(menuRow(page, 'New Folder').locator('.wm-shortcut')).toHaveText('⇧⌘N');
  await page.keyboard.press('Escape');
  await app.focus();
  await page.keyboard.press('Meta+Shift+N');
  await expect(panel(page)).toBeVisible();
  await name(page, 'Later');
});
