import { expect, test } from '../fixtures';
import { importFile } from '../files/helpers';
import { pageBoxes } from './helpers';
import type { App } from '../fixtures';

const DRAWING = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
  <rect id="red" x="20" y="20" width="120" height="80" fill="#e53935" stroke="#000" stroke-width="4"/>
  <circle id="green" cx="300" cy="100" r="60" fill="#43a047"/>
</svg>`;

async function openDrawing(app: App, svg = DRAWING, name = 'drawing.svg'): Promise<void> {
  await app.blank();
  await importFile(app, { name, mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await app.menubar.getByRole('menuitem', { name: 'Drawing' }).waitFor({ timeout: 30_000 });
  await app.page.waitForFunction(() => (window as unknown as { pages: unknown[] }).pages.length === 1);
  // The editor is a chunk fetched when the drawing opens: its layers panel is there when it is ready.
  await expect(app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem')).toHaveCount(2, { timeout: 30_000 });
}

/** The drawing's file, downloaded (File ▸ Download). */
async function currentSvg(app: App): Promise<string> {
  return (await app.download(() => app.menu('File', 'Download'))).text;
}

/** A point on the page of the drawing, from the fractions of its width and height. */
async function onPage(app: App, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = await app.page.locator('.wm-vector-canvas').boundingBox();
  if (!box) throw new Error('the drawing is not shown');
  // The page is centred in the view, with a margin: the drawing's own area is found from the white of its page.
  const area = await app.page.evaluate(() => {
    const canvas = document.querySelector('.wm-vector-canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let x0 = width;
    let y0 = height;
    let x1 = 0;
    let y1 = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const i = (y * width + x) * 4;
        if (data[i + 3] > 200) {
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
  return { x: box.x + area.x0 + (area.x1 - area.x0) * fx, y: box.y + area.y0 + (area.y1 - area.y0) * fy };
}


test('tmp', async ({ app }) => {
  await openDrawing(app);
  const at = await onPage(app, 0.75, 0.5);
  await app.page.mouse.click(at.x, at.y);
  await app.page.getByRole('button', { name: 'Fill Color options' }).click();
  await app.page.locator('.wm-palette').getByRole('button', { name: 'Radial' }).click();
  await app.page.locator('.wm-grad-stop').first().waitFor();
  const bar = await app.page.locator('.wm-grad-bar').boundingBox();
  await app.page.mouse.click(bar!.x + bar!.width / 2, bar!.y + 8);
  await app.page.locator('.wm-palette').getByRole('button', { name: '#FF0000' }).click();
  await app.page.keyboard.press('Escape');
  await app.page.mouse.move(5, 5);
  await app.page.waitForTimeout(300);
  await app.page.screenshot({ path: 'e2e/.tmp.png' });
});
