import { expect, MOD, test, type App } from '../fixtures';
import { editMode, makePdf, modeButton, openPdf, pageBoxes, pageCount, selectBetween, showPage } from './helpers';

const item = (app: App, index: number) => app.page.locator('.wm-pages-item').nth(index);
const panel = (app: App) => app.page.locator('.wm-pages');

const threePages = () =>
  makePdf({
    pages: [
      [{ text: 'Alpha page', x: 40, y: 240, size: 18 }],
      [{ text: 'Bravo page', x: 40, y: 240, size: 18 }],
      [{ text: 'Charlie page', x: 40, y: 240, size: 18 }],
    ],
  });

/** The text of each page, read by selecting across it in Fill In mode (where a drag selects text; from the far corner, as the palette sits over the near one). */
async function pageTexts(app: App): Promise<string[]> {
  await modeButton(app.page, 'Fill In').click();
  const boxes = await pageBoxes(app.page);
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    await showPage(app.page, i);
    out.push((await selectBetween(app.page, i, [boxes[i].width - 2, boxes[i].height - 2], [15, 15])).trim());
  }
  await editMode(app.page);
  return out;
}

test.describe('Page Sidebar', () => {
  test('it is open by default when the window has room, and closed on a narrow one, until chosen', async ({ app, page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await app.blank();
    await expect(panel(app)).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(panel(app)).toBeVisible();
    await app.menu('View', 'Page Sidebar');
    await expect(panel(app)).toBeHidden();
    await page.reload();
    await app.ready();
    await expect(panel(app)).toBeHidden();
  });

  test('View ▸ Page Sidebar pulls the panel out beside the document, with a thumbnail per page', async ({ app }) => {
    await openPdf(app, threePages());
    await expect(panel(app)).toBeHidden();
    const before = (await app.canvas.boundingBox())!.width;
    await app.menu('View', 'Page Sidebar');
    await expect(panel(app)).toBeVisible();
    await expect(app.page.locator('.wm-pages-item')).toHaveCount(3);
    expect((await app.canvas.boundingBox())!.width).toBeLessThan(before);
    // The thumbnails are drawn (a page is white; text makes some pixels dark).
    await expect
      .poll(() =>
        item(app, 0).locator('canvas').evaluate((c: HTMLCanvasElement) => {
          const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          for (let i = 0; i < data.length; i += 4) if (data[i] < 200) return true;
          return false;
        }),
      )
      .toBe(true);
    await app.menu('View', 'Page Sidebar');
    await expect(panel(app)).toBeHidden();
  });

  test('the choice is kept, and Alt+P toggles it', async ({ app }) => {
    await openPdf(app, threePages());
    await app.page.keyboard.press('Alt+KeyP');
    await expect(panel(app)).toBeVisible();
    await app.page.reload();
    await app.ready();
    await expect(panel(app)).toBeVisible();
    await panel(app).getByRole('button', { name: 'Close' }).click();
    await expect(panel(app)).toBeHidden();
  });

  test('clicking a page goes to it, and the page in view is marked', async ({ app }) => {
    await openPdf(app, threePages());
    await app.menu('View', 'Page Sidebar');
    await expect(item(app, 0)).toHaveClass(/wm-pages-current/);
    await item(app, 2).click();
    await expect(item(app, 2)).toHaveClass(/wm-pages-current/);
    await expect(item(app, 0)).not.toHaveClass(/wm-pages-current/);
  });

  test('Fill In mode only looks; Edit PDF mode drags pages into order and deletes them', async ({ app }) => {
    await openPdf(app, threePages());
    await app.menu('View', 'Page Sidebar');
    await expect(app.page.locator('.wm-pages-hint')).toBeVisible();
    await expect(item(app, 0)).toHaveAttribute('draggable', 'false');
    await editMode(app.page);
    await expect(app.page.locator('.wm-pages-hint')).toBeHidden();
    await expect(item(app, 0)).toHaveAttribute('draggable', 'true');

    // Alpha dragged below Charlie.
    const last = (await item(app, 2).boundingBox())!;
    await item(app, 0).dragTo(item(app, 2), { targetPosition: { x: last.width / 2, y: last.height - 4 } });
    await expect.poll(() => pageTexts(app)).toEqual(['Bravo page', 'Charlie page', 'Alpha page']);

    // Delete the first (Bravo) with its button.
    await item(app, 0).hover();
    await item(app, 0).getByRole('button', { name: 'Delete page 1' }).click();
    await expect.poll(() => pageCount(app.page)).toBe(2);
    await expect(app.page.locator('.wm-pages-item')).toHaveCount(2);
    expect(await pageTexts(app)).toEqual(['Charlie page', 'Alpha page']);

    // Undo brings it back, panel and all.
    await app.page.keyboard.press(`${MOD}+z`);
    await expect.poll(() => pageCount(app.page)).toBe(3);
    await expect(app.page.locator('.wm-pages-item')).toHaveCount(3);
  });

  test('the Delete key deletes the focused page, and the last page cannot be deleted', async ({ app }) => {
    await openPdf(app, threePages());
    await app.menu('View', 'Page Sidebar');
    await editMode(app.page);
    await item(app, 1).focus();
    await app.page.keyboard.press('Delete');
    await expect.poll(() => pageCount(app.page)).toBe(2);
    await item(app, 0).focus();
    await app.page.keyboard.press('Delete');
    await expect.poll(() => pageCount(app.page)).toBe(1);
    await expect(app.page.locator('.wm-pages-delete').first()).toBeHidden();
    await item(app, 0).focus();
    await app.page.keyboard.press('Delete');
    expect(await pageCount(app.page)).toBe(1);
  });

  test('a Word document gets thumbnails and navigation, and can still be edited with the panel open', async ({ app }) => {
    await app.blank();
    await app.type('one');
    await app.press(`${MOD}+Enter`);
    await app.type('two');
    await expect(panel(app)).toBeVisible();
    await expect(app.page.locator('.wm-pages-item')).toHaveCount(2);
    await expect(app.page.locator('.wm-pages-delete').first()).toBeHidden();
    await expect(item(app, 0)).toHaveAttribute('draggable', 'false');
    await app.focus();
    await app.page.keyboard.type(' more');
    expect(await app.text()).toContain('two more');
    await item(app, 0).click();
    await expect(item(app, 0)).toHaveClass(/wm-pages-current/);
  });
});
