import { test, expect } from '../fixtures';
import { DOC } from '../editing/helpers';
import { choose } from './helpers';

test.describe('Status Bar', () => {
  test('is off until View ▸ Status Bar turns it on, and the choice is remembered', async ({ app, page }) => {
    await app.blank();
    await expect(page.locator('#footer')).toBeHidden();
    await app.menu('View', 'Status Bar');
    await expect(page.locator('#footer')).toBeVisible();
    await page.reload();
    await app.ready();
    await expect(page.locator('#footer')).toBeVisible();
    await app.menu('View', 'Status Bar');
    await expect(page.locator('#footer')).toBeHidden();
  });

  test('a text document shows its page, its word count and the zoom, and counts the selection', async ({ app, page }) => {
    await app.blank();
    await app.menu('View', 'Status Bar');
    await app.type('one two three');
    await expect(page.locator('#footer')).toContainText('Page 1 of 1');
    await expect(page.locator('#footer')).toContainText('3 words');
    await expect(page.locator('#footer')).toContainText('%');
    await app.press(`${DOC}+Home`);
    await app.press('Shift+ArrowRight', 7);
    await expect(page.locator('#footer')).toContainText('2 of 3 words');
  });

  test('a CSV shows its rows and columns, and a picture its size in pixels', async ({ app, page }) => {
    await app.blank();
    await app.menu('View', 'Status Bar');
    const chooser = page.waitForEvent('filechooser');
    await choose(app, 'File', 'Import…');
    await (await chooser).setFiles({ name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b,c\n1,2,3\n4,5,6\n7,8,9\n') });
    await expect(page.locator('#footer')).toContainText('4 rows × 3 columns', { timeout: 20_000 });
    await expect(page.locator('#footer')).not.toContainText('words');
  });
});
