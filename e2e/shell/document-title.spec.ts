import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { choose } from './helpers';

const title = (page: Page) => page.getByLabel('Document name');

test.describe('Document name', () => {
  test('shows in the menu bar and is renamed by clicking it', async ({ app, page }) => {
    await app.blank();
    await expect(title(page)).toBeVisible();
    await title(page).click();
    await title(page).fill('Quarterly report');
    await page.keyboard.press('Enter');
    await expect(title(page)).toHaveValue('Quarterly report');
    await expect(app.editor).toBeFocused();
    await expect(page).toHaveTitle(/^Quarterly report/);
  });

  test('Escape leaves the name as it was', async ({ app, page }) => {
    await app.blank();
    const before = await title(page).inputValue();
    await title(page).click();
    await title(page).fill('Never mind');
    await page.keyboard.press('Escape');
    await expect(title(page)).toHaveValue(before);
  });

  test('File ▸ Rename puts the cursor in the name', async ({ app, page }) => {
    await app.blank();
    await choose(app, 'File', 'Rename…');
    await expect(title(page)).toBeFocused();
  });

  test('is left out when the window has no room for it', async ({ app, page }) => {
    await app.blank();
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(title(page)).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(title(page)).toBeVisible();
  });
});
