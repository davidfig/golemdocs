// The browser's Back and Forward buttons move between documents and the Documents screen.

import { expect, test } from './fixtures';
import { importFile, text, waitForSaved } from './helpers';

test('Back returns to the document opened before, and Forward to the one after', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('alpha.txt', 'the first'));
  await waitForSaved(page, 'alpha.txt');
  await importFile(app, text('beta.txt', 'the second'));
  await waitForSaved(page, 'beta.txt');
  await page.goBack();
  await expect.poll(() => page.title(), { timeout: 15_000 }).toContain('alpha');
  await page.goBack();
  await expect.poll(() => page.title(), { timeout: 15_000 }).toContain('Welcome');
  await page.goForward();
  await expect.poll(() => page.title(), { timeout: 15_000 }).toContain('alpha');
});

test('Back closes the Documents screen, and Esc leaves nothing behind in history', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await app.menu('File', 'Open…');
  await expect(page.locator('.wm-dashboard')).toBeVisible();
  await page.goBack();
  await expect(page.locator('.wm-dashboard')).toBeHidden();
  await app.menu('File', 'Open…');
  await page.keyboard.press('Escape');
  await expect(page.locator('.wm-dashboard')).toBeHidden();
  await expect.poll(() => page.evaluate(() => history.state)).toBeNull();
});
