// The dashboard's multi-select: ticking documents and folders, then moving or deleting them together.

import type { Page } from '@playwright/test';
import { expect, test, type App } from './fixtures';
import { importFile, text, waitForSaved } from './helpers';

const dashboard = (page: Page) => page.locator('.wm-dashboard');
const cards = (page: Page) => dashboard(page).locator('article.wm-card:not(.wm-folder)');
const folders = (page: Page) => dashboard(page).locator('article.wm-folder');
const card = (page: Page, name: string) => cards(page).filter({ hasText: name });

async function setup(app: App): Promise<void> {
  await app.goto('?doc=welcome');
  for (const file of [text('alpha.txt', 'the first'), text('beta.md', '# second')]) {
    await importFile(app, file);
    await waitForSaved(app.page, file.name);
  }
  await app.menu('File', 'Open…');
  await expect(dashboard(app.page).getByRole('searchbox', { name: 'Search documents' })).toBeFocused();
}

test('ticked documents and a folder move together; Esc clears the selection before closing', async ({ app, page }) => {
  await setup(app);
  await dashboard(page).getByRole('button', { name: 'New folder', exact: true }).click();
  const field = dashboard(page).getByRole('textbox', { name: 'Folder name' });
  await field.fill('Reports');
  await field.press('Enter');
  await expect(folders(page)).toHaveCount(1);

  await card(page, 'alpha.txt').hover();
  await card(page, 'alpha.txt').getByRole('checkbox').check();
  await card(page, 'beta.md').hover();
  await card(page, 'beta.md').getByRole('checkbox').check();
  await expect(dashboard(page).getByRole('status').filter({ hasText: 'selected' })).toHaveText('2 selected');

  await dashboard(page).getByRole('button', { name: 'Move the selected items' }).click();
  await dashboard(page).getByRole('dialog').getByRole('button', { name: 'Reports' }).click();
  await expect(cards(page)).toHaveCount(0);
  await expect(folders(page).locator('.wm-card-meta')).toHaveText('2 items');

  await dashboard(page).getByRole('heading').click();
  await page.keyboard.press('Control+a');
  await expect(dashboard(page).getByRole('status').filter({ hasText: 'selected' })).toHaveText('1 selected');
  await page.keyboard.press('Escape');
  await expect(dashboard(page)).toBeVisible();
  await expect(dashboard(page).getByRole('button', { name: 'Clear selection' })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(dashboard(page)).toBeHidden();
});

test('Delete removes every ticked document after confirming in the dialog', async ({ app, page }) => {
  await setup(app);
  await dashboard(page).getByRole('heading').click(); // off the search box, which keeps Ctrl+A for its text
  await page.keyboard.press('Control+a');
  await expect(dashboard(page).getByRole('status').filter({ hasText: 'selected' })).toHaveText('2 selected');
  const del = dashboard(page).locator('.wm-dash-selection').getByRole('button', { name: 'Delete' });
  await del.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.locator('.wm-delete-list li')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(cards(page)).toHaveCount(0);
});

test('Shift-click ticks a range from the last card ticked', async ({ app, page }) => {
  await setup(app);
  await card(page, 'alpha.txt').click({ modifiers: ['ControlOrMeta'] });
  await card(page, 'beta.md').click({ modifiers: ['Shift'] });
  await expect(dashboard(page).getByRole('status').filter({ hasText: 'selected' })).toHaveText('2 selected');
});
