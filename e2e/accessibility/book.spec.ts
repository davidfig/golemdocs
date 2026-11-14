// Reading a book (an EPUB, read-only) with Screen Reader Mode on (docs/architecture/accessibility.md, "Books"): the reading
// layer describes its pages, a page turn says where the reader is and takes the caret (and so the textarea) to the top of the
// new page, the arrows move the caret rather than turn pages, typing is refused out loud, and a tap at the side of the page
// is left to the screen reader instead of turning it.

import type { Page } from '@playwright/test';
import { expect, test, type App } from '../fixtures';
import { buildEpub, importFile } from '../files/helpers';

test.use({ statusBarDefault: true });

async function screenReaderOn(app: App): Promise<void> {
  await app.menu('Tools', 'Screen Reader Mode');
  await expect(app.page.locator('.wm-sr-only[aria-live]', { hasText: 'Screen Reader Mode on' })).toHaveCount(1);
}

/** The page in view, from the status bar. */
async function pageInView(page: Page): Promise<number> {
  const match = /Page (\d+) of (\d+)/.exec((await page.locator('.wm-footer-items').textContent()) ?? '');
  return match ? Number(match[1]) : 0;
}

const mirror = (app: App) => app.editor.evaluate((el: HTMLTextAreaElement) => ({ value: el.value, start: el.selectionStart, end: el.selectionEnd }));
/** A turn to page 2 as said: the page and how far through, then what the caret found there (its style), if anything. */
const TURNED_TO_2 = /^Page 2 of \d+, \d+% read(\. .+)?$/;
const said = (app: App) => app.page.locator('.wm-sr-only[aria-live="polite"]');

test('a book is read with Screen Reader Mode: its pages are described, and a page turn is said and moves the caret to the new page', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importFile(app, buildEpub());
  await screenReaderOn(app);
  await app.focus();

  // The reading layer: the book's chapters are headings, its paragraphs paragraphs.
  const layer = page.locator('.wm-reading');
  await expect(layer.locator('h1').first()).toHaveText('Chapter 1');
  await expect(layer.locator('.wm-reading-page p').first()).toContainText('Chapter 1, paragraph 1.');
  await expect.poll(() => pageInView(page)).toBe(1);

  // Page Down turns the page, says so as the status bar does, and the textarea holds the text at the top of the new page.
  await app.press('PageDown');
  await expect.poll(() => pageInView(page)).toBe(2);
  await expect(said(app)).toHaveText(TURNED_TO_2);
  const top = (await layer.locator('section[aria-label="Page 2"] .wm-reading-piece').first().textContent())!.trim().slice(0, 40);
  expect(top.length).toBeGreaterThan(10);
  await expect.poll(() => mirror(app).then((m) => m.value.includes(top))).toBe(true);
  // The caret reached a new page with the turn: that page is not said a second time.
  await app.settle();
  expect((await said(app).textContent())?.match(/Page 2/g)?.length ?? 0).toBeLessThanOrEqual(1);

  // The arrows move the caret (read by character and line), not the page.
  const before = await mirror(app);
  await app.press('ArrowRight');
  await expect.poll(() => mirror(app).then((m) => m.start)).toBe(before.start + 1);
  await app.press('ArrowDown');
  await app.settle();
  expect(await pageInView(page)).toBe(2);

  // Space and Page Up still turn pages.
  await app.press(' ');
  await expect.poll(() => pageInView(page)).toBe(3);
  await app.press('PageUp');
  await expect.poll(() => pageInView(page)).toBe(2);
  await expect(said(app)).toHaveText(TURNED_TO_2);
});

test('typing in a book is refused, and Screen Reader Mode says why; the mirror keeps the book’s text', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importFile(app, buildEpub());
  await screenReaderOn(app);
  await app.focus();
  await app.press('ArrowRight');
  await expect.poll(() => mirror(app).then((m) => m.value)).toContain('Chapter 1');
  await page.waitForTimeout(300);
  const before = await mirror(app);
  await app.type('xyz');
  await expect(said(app)).toHaveText('This book can only be read. To change it, make a document from it with File › Convert To.');
  await app.press('Backspace');
  await app.settle();
  expect(await mirror(app)).toEqual(before);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test('in Screen Reader Mode a tap at the side of a book’s page is left to the screen reader, not a page turn', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await importFile(app, buildEpub());
    await screenReaderOn(app);
    await expect.poll(() => pageInView(page)).toBe(1);
    const box = (await page.locator('#canvas').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const at = { x: box.x + box.width * 0.9, y: box.y + box.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await app.settle();
    await page.waitForTimeout(300);
    expect(await pageInView(page)).toBe(1);
  });
});
