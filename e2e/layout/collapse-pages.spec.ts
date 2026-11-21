import type { Page } from '@playwright/test';
import { expect, MOD, test, type App } from '../fixtures';
import { isChecked, menuRow, openMenu } from '../shell/helpers';

const pagesInfo = (page: Page) =>
  page.evaluate(() => {
    // The part of each page on view: all of it, or its body between the margins while the white space is hidden.
    const w = window as unknown as { pages: { y: number; height: number; shown: { top: number; bottom: number } | null }[] };
    return w.pages.map((p) => ({ y: p.y + (p.shown?.top ?? 0), height: (p.shown?.bottom ?? p.height) - (p.shown?.top ?? 0), whole: p.height, cropped: !!p.shown }));
  });

/** Where a point of the document is on the screen (CSS pixels, window coordinates). */
const screenOf = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      const w = window as unknown as { camera: { x: number; y: number; zoom: number } };
      const box = document.getElementById('canvas')!.getBoundingClientRect();
      const scale = w.camera.zoom * (96 / 72);
      return { x: box.left + (px - w.camera.x) * scale, y: box.top + (py - w.camera.y) * scale };
    },
    [x, y],
  );

async function twoPages(app: App): Promise<void> {
  await app.blank();
  await app.type('one');
  await app.press(`${MOD}+Enter`);
  await app.type('two');
  await expect.poll(async () => (await pagesInfo(app.page)).length).toBe(2);
}

const cursor = (page: Page) => page.evaluate(() => document.getElementById('canvas')!.style.cursor);

const gapOf = async (page: Page): Promise<number> => {
  const [a, b] = await pagesInfo(page);
  return b.y - (a.y + a.height);
};

test.describe('Hide space between pages', () => {
  test('double-clicking between two pages hides the gap, and again shows it', async ({ app, page }) => {
    await twoPages(app);
    expect(await gapOf(page)).toBeGreaterThan(0);
    const [a, b] = await pagesInfo(page);
    const at = await screenOf(page, 300, (a.y + a.height + b.y) / 2);
    // Over the gap the pointer shows what a double click does: arrows closing on it.
    await page.mouse.move(at.x, at.y);
    await expect.poll(() => cursor(page)).toContain('row-resize');
    const closing = await cursor(page);
    await page.mouse.dblclick(at.x, at.y);
    await expect.poll(() => gapOf(page)).toBe(0);
    const joined = await pagesInfo(page);
    // As in Word, the top and bottom margins go too: only each page's body is shown.
    expect(joined.every((p) => p.cropped && p.height < p.whole)).toBe(true);
    const seam = await screenOf(page, 300, joined[0].y + joined[0].height);
    // On the seam now, the arrows point apart: a double click shows the space again.
    await page.mouse.move(seam.x, seam.y);
    await expect.poll(() => cursor(page)).toContain('row-resize');
    expect(await cursor(page)).not.toBe(closing);
    await page.mouse.dblclick(seam.x, seam.y);
    await expect.poll(() => gapOf(page)).toBeGreaterThan(0);
    expect((await pagesInfo(page)).every((p) => !p.cropped && p.height === p.whole)).toBe(true);
    // Away from the seam, the usual pointer.
    const inside = await screenOf(page, 300, (await pagesInfo(page))[0].y + 100);
    await page.mouse.move(inside.x, inside.y);
    await expect.poll(() => cursor(page)).toBe('');
  });

  test('the View menu toggles it and the choice is remembered', async ({ app, page }) => {
    await twoPages(app);
    await openMenu(app, 'View');
    await menuRow(page, 'Hide Space Between Pages').click();
    await expect.poll(() => gapOf(page)).toBe(0);
    await page.reload();
    await app.ready();
    await expect.poll(async () => (await pagesInfo(page)).length).toBe(2);
    expect(await gapOf(page)).toBe(0);
    await openMenu(app, 'View');
    expect(await isChecked(page, 'Hide Space Between Pages')).toBe(true);
  });
});
