// Copying a PDF's text: Edit › Copy, the keyboard, Select All, and on a phone a long press and the menu's Copy.

import { expect, test } from '../fixtures';
import { dropFile } from '../files/helpers';
import { makePdf, movePaletteAside, openPdf, pointOnPage, selectBetween, settle, showPage } from './helpers';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const sample = () => makePdf({ pages: [[{ text: 'Hello PDF world', x: 40, y: 240, size: 18 }]] });
const clipboard = (page: import('@playwright/test').Page) => page.evaluate(() => navigator.clipboard.readText());
const HELLO: [[number, number], [number, number]] = [[41, 54], [120, 54]];

test.describe('on a computer', () => {
  test.beforeEach(async ({ app }) => {
    await openPdf(app, sample());
    await showPage(app.page, 0);
  });

  test('Edit › Copy puts the selected text on the clipboard', async ({ app }) => {
    await selectBetween(app.page, 0, ...HELLO);
    await app.menu('Edit', 'Copy');
    await expect.poll(() => clipboard(app.page)).toBe('Hello PDF ');
  });

  test('the copy shortcut does too', async ({ app }) => {
    await selectBetween(app.page, 0, ...HELLO);
    await app.press('ControlOrMeta+c');
    await expect.poll(() => clipboard(app.page)).toBe('Hello PDF ');
  });

  test('Edit › Select All, then Copy, takes the page\'s text', async ({ app }) => {
    await app.menu('Edit', 'Select All');
    await expect.poll(() => app.selectedText()).toContain('world');
    await app.menu('Edit', 'Copy');
    await expect.poll(() => clipboard(app.page)).toBe('Hello PDF world');
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a long press selects a word, and the menu\'s Copy copies it', async ({ app, page }) => {
    // A phone has no File › Import to hand: the file arrives as a dropped one does.
    await app.goto('?doc=welcome');
    await dropFile(page, { name: 'sample.pdf', mimeType: 'application/pdf', buffer: sample() });
    await expect(page.locator('.wm-forms-palette')).toBeVisible();
    await movePaletteAside(page);
    await settle(page);
    await showPage(page, 0);
    const at = await pointOnPage(page, 0, 100, 54);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
    await expect.poll(async () => (await app.selectedText()).trim()).toBe('PDF');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('menuitem', { name: /^Copy/ }).click();
    await expect.poll(async () => (await clipboard(page)).trim()).toBe('PDF');
  });
});
