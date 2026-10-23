import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { PHONE, choose } from './helpers';

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

// A touch screen with no hover, as a phone is: renaming always asks in a dialog, since its field takes the focus during the tap.
test.describe('Document name on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('the menu names the document and a tap on the name renames it', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    const drawer = page.getByRole('dialog', { name: 'Menu' });
    await page.getByRole('button', { name: 'Menu' }).click();
    await drawer.getByRole('menuitem', { name: /^New/ }).click();
    await page.getByRole('button', { name: 'Menu' }).click();
    const name = drawer.locator('button.wm-drawer-doc');
    await expect(name).toBeVisible();
    await name.click();
    const dialog = page.locator('dialog.wm-dialog', { hasText: 'Rename Document' });
    const field = dialog.getByLabel('Document name');
    await expect(field).toBeFocused();
    await field.fill('Written on a phone');
    await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page).toHaveTitle(/^Written on a phone/);
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(drawer.locator('.wm-drawer-doc-name')).toHaveText('Written on a phone');
  });

  test('File › Rename is in the menu and asks in a dialog', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('menuitem', { name: /^New/ }).click();
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('menuitem', { name: /^Rename/ }).click();
    const field = page.locator('dialog.wm-dialog').getByLabel('Document name');
    await expect(field).toBeFocused();
    await field.fill('From the menu');
    await page.keyboard.press('Enter');
    await expect(page).toHaveTitle(/^From the menu/);
  });

  test('a built-in page has no name to rename in the menu', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await page.getByRole('button', { name: 'Menu' }).click();
    const drawer = page.getByRole('dialog', { name: 'Menu' });
    await expect(drawer.locator('button.wm-drawer-doc')).toHaveCount(0);
    await expect(drawer.getByRole('menuitem', { name: /^Rename/ })).toHaveAttribute('aria-disabled', 'true');
  });
});
