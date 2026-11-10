// An EPUB is a book: read, never edited. Its pages turn with the keyboard, the status bar says how far through it the
// reader is, and it opens again where it was left (src/reading.ts; kept in the account too, for other devices).

import type { Page } from '@playwright/test';
import { expect, MOD, test } from './fixtures';
import { buildEpub, convertTo, formatLabel, importFile, status } from './helpers';

test.use({ statusBarDefault: true });

const statusBar = (page: Page) => page.locator('.wm-footer-items');
/** The page in view, from the status bar. */
async function pageInView(page: Page): Promise<number> {
  const match = /Page (\d+) of (\d+)/.exec((await statusBar(page).textContent()) ?? '');
  return match ? Number(match[1]) : 0;
}
/** How far through the book the status bar says the reader is. */
async function percentRead(page: Page): Promise<number> {
  const match = /(\d+)% read/.exec((await statusBar(page).textContent()) ?? '');
  return match ? Number(match[1]) : -1;
}
/** The paragraph of the place this browser keeps for the (only) book. */
const keptParagraph = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem('golemdocs.reading') ?? '[]') as [string, { place: [number, number] }][])[0]?.[1].place[0] ?? -1);
/** The places this browser keeps, by book. */
const keptPages = (page: Page) =>
  page.evaluate(() => (JSON.parse(localStorage.getItem('golemdocs.reading') ?? '[]') as [string, { page: number }][]).map(([, place]) => place.page));

test('a book opens read-only, turns its pages with the keyboard, and opens again on the page it was left at', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importFile(app, buildEpub());
  expect(await formatLabel(page)).toBe('EPUB Book');
  const before = await app.text();
  expect(before).toContain('Chapter 1, paragraph 1.');

  // Read, not edited: what is typed goes nowhere.
  await app.type('XYZ');
  await app.press('Enter');
  await app.settle();
  expect(await app.text()).toBe(before);

  // How far through it is, not how many words it has.
  await expect(statusBar(page)).toContainText('% read');
  await expect(statusBar(page)).not.toContainText('words');

  // Page Down, the right arrow and Space each turn a page; Page Up turns one back. (Reading the text above left the caret at the end.)
  await app.press(`${MOD}+Home`);
  await expect.poll(() => pageInView(page)).toBe(1);
  await app.press('PageDown', 2);
  await app.press('ArrowRight');
  await app.press(' ');
  await app.press('PageUp');
  await expect.poll(() => pageInView(page)).toBe(4);

  // The place is kept as soon as the reading settles.
  await expect.poll(() => keptPages(page), { timeout: 10_000 }).toEqual([4]);

  await page.reload();
  await app.ready();
  await app.settle();
  expect(await formatLabel(page)).toBe('EPUB Book');
  await expect.poll(() => pageInView(page), { timeout: 15_000 }).toBe(4);
});

test('a book’s place is the same text in Flow view, whatever the window’s width', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importFile(app, buildEpub());
  await app.press('PageDown', 6);
  await expect.poll(() => keptPages(page), { timeout: 10_000 }).toEqual([7]);
  const place = [await keptParagraph(page)];

  await app.menu('View', 'Flow');
  await page.setViewportSize({ width: 700, height: 800 });
  await page.reload();
  await app.ready();
  await app.settle();
  // Back at the same text (the paragraph read at the top of the view), though Flow has no pages: well into the book, and
  // the place it keeps is still that paragraph.
  await expect.poll(() => percentRead(page), { timeout: 15_000 }).toBeGreaterThan(25);
  await app.press('ArrowUp'); // a screen back and forward again: the view has settled and moved, and so is looked up anew
  await app.press('ArrowDown');
  await expect.poll(() => keptParagraph(page), { timeout: 10_000 }).toBe(place[0]);
});

test('Convert To makes a document to edit from a book, and the book stays as it was', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importFile(app, buildEpub());
  await convertTo(app, 'Word Document (.docx)', 'Word Document');
  await expect.poll(() => status(page)).toContain('The book itself is unchanged');
  // The copy can be edited.
  await app.press(`${MOD}+Home`);
  await app.type('Notes: ');
  await expect.poll(async () => (await app.text()).startsWith('Notes: Chapter 1')).toBe(true);
  // Both are in the library: the book and the document made from it.
  const names = () => page.evaluate(() => ((window as unknown as { library: { entries: { name: string }[] } }).library.entries.map((e) => e.name)).sort());
  await expect.poll(names, { timeout: 10_000 }).toEqual(['The River.docx', 'The River.epub']);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  /** A finger: put down, moved, lifted (real touches, through the browser's devtools protocol). */
  async function finger(page: Page) {
    const cdp = await page.context().newCDPSession(page);
    const fire = (type: 'touchStart' | 'touchMove' | 'touchEnd', at?: { x: number; y: number }) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at ? [{ x: at.x, y: at.y }] : [] });
    return {
      tap: async (at: { x: number; y: number }) => {
        await fire('touchStart', at);
        await fire('touchEnd');
      },
      swipe: async (from: { x: number; y: number }, to: { x: number; y: number }) => {
        await fire('touchStart', from);
        for (let i = 1; i <= 6; i++) await fire('touchMove', { x: from.x + ((to.x - from.x) * i) / 6, y: from.y + ((to.y - from.y) * i) / 6 });
        await fire('touchEnd');
      },
    };
  }

  test('a tap at either side or a sideways swipe turns the page, and no keyboard comes up', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await importFile(app, buildEpub());
    await expect.poll(() => pageInView(page)).toBe(1);
    // Nothing is typed in a book: the on-screen keyboard is not asked for.
    expect(await page.locator('#input').getAttribute('inputmode')).toBe('none');
    const box = (await page.locator('#canvas').boundingBox())!;
    const at = (x: number) => ({ x: box.x + box.width * x, y: box.y + box.height / 2 });
    const f = await finger(page);

    await f.tap(at(0.9));
    await expect.poll(() => pageInView(page)).toBe(2);
    await f.tap(at(0.9));
    await expect.poll(() => pageInView(page)).toBe(3);
    await f.tap(at(0.1));
    await expect.poll(() => pageInView(page)).toBe(2);

    // Right to left goes on; left to right goes back.
    await f.swipe(at(0.7), at(0.3));
    await expect.poll(() => pageInView(page)).toBe(3);
    await f.swipe(at(0.3), at(0.7));
    await expect.poll(() => pageInView(page)).toBe(2);

    // A tap in the middle turns nothing.
    await f.tap(at(0.5));
    await app.settle();
    expect(await pageInView(page)).toBe(2);
  });
});
