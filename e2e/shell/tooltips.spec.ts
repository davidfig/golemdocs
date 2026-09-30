import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { isMac } from './helpers';

const tip = (page: Page) => page.getByRole('tooltip');

test.describe('tooltips', () => {
  test('a toolbar button shows its name and shortcut after the pointer rests on it', async ({ app, page }) => {
    await app.blank();
    const bold = app.toolbarButton('Bold');
    await bold.hover();
    // Not at once: there is a short delay before a tip appears.
    await expect(tip(page)).toBeHidden({ timeout: 100 });
    await expect(tip(page)).toBeVisible();
    await expect(tip(page)).toHaveText((await isMac(page)) ? 'Bold (⌘B)' : 'Bold (Ctrl+B)');
  });

  test('the browser’s own tooltip is suppressed: the title moves to data-tip', async ({ app }) => {
    await app.blank();
    const bold = app.toolbarButton('Bold');
    await bold.hover();
    await expect(bold).not.toHaveAttribute('title', /.+/);
    await expect(bold).toHaveAttribute('data-tip', /^Bold/);
    await expect(bold).toHaveAccessibleName('Bold');
  });

  test('the tip appears below the button, on screen, and is centered on it where it fits', async ({ app, page }) => {
    await app.blank();
    const italic = app.toolbarButton('Italic');
    await italic.hover();
    await expect(tip(page)).toBeVisible();
    const button = (await italic.boundingBox())!;
    const box = (await tip(page).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(button.y + button.height - 2);
    expect(box.y).toBeLessThan(button.y + button.height + 40);
    expect(Math.abs(box.x + box.width / 2 - (button.x + button.width / 2))).toBeLessThan(40);
  });

  test('near the right edge of the window the tip is moved to stay inside it', async ({ app, page }) => {
    await app.blank();
    const last = app.toolbarButton('Keyboard Shortcuts');
    await last.hover();
    await expect(tip(page)).toBeVisible();
    const box = (await tip(page).boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  });

  test('moving from one button to the next shows the next tip almost at once', async ({ app, page }) => {
    await app.blank();
    await app.toolbarButton('Bold').hover();
    await expect(tip(page)).toBeVisible();
    await app.toolbarButton('Italic').hover();
    await expect(tip(page)).toContainText('Italic', { timeout: 400 });
    await expect(tip(page)).toBeVisible();
  });

  test('a tip goes away when the pointer leaves, when a button is pressed, and when a key is typed', async ({ app, page }) => {
    await app.blank();
    await app.toolbarButton('Bold').hover();
    await expect(tip(page)).toBeVisible();
    await page.mouse.move(640, 500);
    await expect(tip(page)).toBeHidden();

    await app.toolbarButton('Underline').hover();
    await expect(tip(page)).toBeVisible();
    await app.toolbarButton('Underline').click();
    await expect(tip(page)).toBeHidden();

    await app.toolbarButton('Italic').hover();
    await expect(tip(page)).toBeVisible();
    await page.keyboard.type('a');
    await expect(tip(page)).toBeHidden();
  });

  test('a tip goes away when the wheel scrolls', async ({ app, page }) => {
    await app.blank();
    await app.toolbarButton('Bold').hover();
    await expect(tip(page)).toBeVisible();
    await page.mouse.wheel(0, 50);
    await expect(tip(page)).toBeHidden();
  });

  test('a pressed button shows no tip again until the pointer has gone elsewhere and come back', async ({ app, page }) => {
    await app.blank();
    const bold = app.toolbarButton('Bold');
    await bold.click();
    await page.mouse.move(0, 0);
    await bold.hover();
    await expect(tip(page)).toBeVisible();
  });

  test('other controls have tips too: the zoom box, the document format box and the palette button', async ({ app, page }) => {
    await app.blank();
    await page.getByRole('toolbar').getByRole('combobox', { name: 'Zoom' }).hover();
    await expect(tip(page)).toHaveText('Zoom');
    await page.getByRole('combobox', { name: 'Document format' }).hover();
    await expect(tip(page)).toContainText('Document format');
    await page.getByRole('button', { name: 'Command palette' }).hover();
    await expect(tip(page)).toContainText('Command palette');
  });

  test('shortcut text follows a customized shortcut', async ({ app, page }) => {
    await app.blank();
    await page.keyboard.press('F1');
    await page.getByRole('button', { name: 'Change shortcut for Bold' }).click();
    await page.keyboard.press('F8');
    await page.keyboard.press('Escape');
    await app.toolbarButton('Bold').hover();
    await expect(tip(page)).toHaveText('Bold (F8)');
  });

  test('a long tip wraps inside the window instead of running off it', async ({ app, page }) => {
    await app.blank();
    await app.toolbarButton('Format Painter').hover();
    await expect(tip(page)).toContainText('Format Painter: select text');
    const box = (await tip(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });
});
