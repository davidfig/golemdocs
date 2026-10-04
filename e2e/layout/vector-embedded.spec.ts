import { expect, test } from '../fixtures';
import type { App } from '../fixtures';
import { importFile } from '../files/helpers';

/** The drawing's white area on the layer, in page coordinates (the dimmed rest has less than full alpha). */
async function drawingArea(app: App): Promise<{ x0: number; y0: number; x1: number; y1: number }> {
  const box = await app.page.locator('.wm-vector-canvas').boundingBox();
  if (!box) throw new Error('no drawing is lit');
  const area = await app.page.evaluate(() => {
    const canvas = document.querySelector('.wm-vector-canvas') as HTMLCanvasElement;
    const { width, height } = canvas;
    const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
    let [x0, y0, x1, y1] = [width, height, 0, 0];
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        if (data[(y * width + x) * 4 + 3] > 200) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
    }
    const ratio = width / canvas.clientWidth;
    return { x0: x0 / ratio, y0: y0 / ratio, x1: x1 / ratio, y1: y1 / ratio };
  });
  return { x0: box.x + area.x0, y0: box.y + area.y0, x1: box.x + area.x1, y1: box.y + area.y1 };
}

const layers = (app: App) => app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');

async function insertDrawing(app: App): Promise<void> {
  await app.blank();
  await app.menu('Insert', 'Drawing');
  await expect(layers(app)).toHaveCount(0, { timeout: 30_000 });
  await expect(app.page.getByRole('tree', { name: 'Layers' })).toBeVisible({ timeout: 30_000 });
}

async function drawRectangle(app: App): Promise<void> {
  const a = await drawingArea(app);
  await app.toolbarButton('Rectangle').click();
  await app.page.mouse.move(a.x0 + (a.x1 - a.x0) * 0.2, a.y0 + (a.y1 - a.y0) * 0.2);
  await app.page.mouse.down();
  await app.page.mouse.move(a.x0 + (a.x1 - a.x0) * 0.5, a.y0 + (a.y1 - a.y0) * 0.5);
  await app.page.mouse.move(a.x0 + (a.x1 - a.x0) * 0.7, a.y0 + (a.y1 - a.y0) * 0.7);
  await app.page.mouse.up();
  await expect(layers(app)).toHaveCount(1);
}

test.describe('a vector drawing inside a Word document', () => {
  test('Insert ▸ Drawing lights a blank drawing, dims the rest and offers the vector tools', async ({ app }) => {
    await insertDrawing(app);
    for (const name of ['Select', 'Rectangle', 'Ellipse', 'Pen']) await expect(app.toolbarButton(new RegExp(`^${name}$`))).toBeVisible();
    // The page around the drawing is dimmed: not clear, and not as opaque as the drawing.
    const dimmed = await app.page.evaluate(() => {
      const canvas = document.querySelector('.wm-vector-canvas') as HTMLCanvasElement;
      return canvas.getContext('2d')!.getImageData(2, 2, 1, 1).data[3];
    });
    expect(dimmed).toBeGreaterThan(50);
    expect(dimmed).toBeLessThan(200);
  });

  test('what is drawn stays in the document after leaving, and a double click edits it again', async ({ app }) => {
    await insertDrawing(app);
    await drawRectangle(app);
    const area = await drawingArea(app);
    // A press outside the drawing leaves it, and the lit drawing goes.
    await app.page.mouse.click(area.x0 + 10, area.y1 + 60);
    await expect(app.page.getByRole('tree', { name: 'Layers' })).toBeHidden();
    await expect(app.toolbarButton(/^Rectangle$/)).toHaveCount(0);
    await app.page.mouse.dblclick((area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2);
    await expect(layers(app)).toHaveCount(1, { timeout: 15_000 });
  });

  test('Escape with nothing picked leaves the drawing', async ({ app }) => {
    await insertDrawing(app);
    await app.press('Escape');
    await expect(app.page.getByRole('tree', { name: 'Layers' })).toBeHidden();
  });
});

test.describe('a vector drawing embedded in a Markdown note', () => {
  test('Insert ▸ Drawing stores a drawing and embeds it; editing it keeps the change in the drawing, and the note only embeds it', async ({ app }) => {
    await app.goto('?doc=welcome');
    await importFile(app, { name: 'Home.md', mimeType: 'text/markdown', buffer: Buffer.from('Intro line.\n\n') });
    await app.page.waitForFunction(() => (window as unknown as { loaded: boolean }).loaded === true);
    await app.focus();
    await app.menu('Insert', 'Drawing');
    // The embedded drawing is lit for drawing as soon as the note shows it.
    await expect(app.page.getByRole('tree', { name: 'Layers' })).toBeVisible({ timeout: 30_000 });
    await drawRectangle(app);
    const area = await drawingArea(app);
    await app.page.mouse.click(area.x0 + 10, area.y1 + 60);
    await expect(app.page.getByRole('tree', { name: 'Layers' })).toBeHidden();
    // The note is opened again showing the new picture, and the drawing still has its rectangle.
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { pages: { images: { svg?: string }[] }[] }).pages.some((p) => p.images.some((i) => i.svg)))).toBe(true);
    await app.page.mouse.dblclick((area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2);
    await expect(layers(app)).toHaveCount(1, { timeout: 30_000 });
    await app.press('Escape');
    // The note itself holds the embed, not the drawing.
    // (The note is opened again after the drawing is saved into its own document: it holds the embed once that has settled.)
    await expect
      .poll(async () => (await app.download(() => app.menu('File', 'Download'))).text, { timeout: 30_000 })
      .toMatch(/!\[\[Drawing( \d+)?\.svg\]\]/);
    expect((await app.download(() => app.menu('File', 'Download'))).text).not.toContain('<svg');
  });
});
