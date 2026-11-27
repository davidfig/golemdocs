// An SVG file that embeds its fonts (`@font-face` with a data: URI) is drawn in them, in the drawing editor and in the
// picture of it, and lets go of them when it closes. Ten H's are 0.75 em wide each in the embedded font and 0.6 in the
// fallback, so only the embedded font's reach x 350 of the drawing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type App } from '../fixtures';
import { importFile } from '../files/helpers';

const font = readFileSync(join(import.meta.dirname, '../../pdf/test/fixtures/DejaVuSans-subset.ttf')).toString('base64');
const CSS = `@font-face{font-family:'Poster Face';font-weight:400;src:url(data:font/ttf;base64,${font})}`;
const svg = (css: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100" viewBox="0 0 400 100"><defs><style>${css}</style></defs><text x="10" y="70" font-family="'Poster Face', monospace" font-size="50">HHHHHHHHHH</text></svg>`;

async function open(app: App, source: string, name: string): Promise<void> {
  await app.blank();
  await importFile(app, { name, mimeType: 'image/svg+xml', buffer: Buffer.from(source) });
  await app.menubar.getByRole('menuitem', { name: 'Drawing' }).waitFor({ timeout: 30_000 });
  await expect(app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem')).toHaveCount(1, { timeout: 30_000 });
}

/** How far across the drawing its ink reaches, in the drawing's units (its page is the white of the canvas). */
const reach = (app: App): Promise<number> =>
  app.page.evaluate(() => {
    const canvas = document.querySelector('.wm-vector-canvas') as HTMLCanvasElement;
    const { width, height } = canvas;
    const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
    let [x0, x1, ink] = [width, 0, 0];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i + 3] < 200) continue;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        if (data[i] < 60) ink = Math.max(ink, x);
      }
    return ((ink - x0) / (x1 - x0)) * 400;
  });

const embedded = (app: App): Promise<string[]> => app.page.evaluate(() => [...document.fonts].map((f) => f.family.replace(/"/g, '')).filter((f) => f.startsWith('golem-svg')));

test('text is drawn in the font the file embeds, which goes when the file closes, and the file keeps it', async ({ app }) => {
  await open(app, svg(CSS), 'poster.svg');
  await expect.poll(() => reach(app)).toBeGreaterThan(370);
  expect(await embedded(app)).toHaveLength(1);
  const saved = (await app.download(() => app.menu('File', 'Download'))).text;
  expect(saved).toContain(font.slice(0, 400));
  expect(saved).not.toContain('golem-svg');
  // The next drawing names the same family without embedding it: it is not drawn in the last one's font.
  await open(app, svg('text{fill:#000}'), 'plain.svg');
  await expect.poll(() => embedded(app)).toEqual([]);
  expect(await reach(app)).toBeLessThan(330);
});

test('a font at an address is not fetched', async ({ app, page }) => {
  let asked = false;
  await page.route('**/never.woff2', (route) => {
    asked = true;
    return route.abort();
  });
  await open(app, svg("@font-face{font-family:'Poster Face';src:url(https://fonts.example.com/never.woff2)}"), 'remote.svg');
  expect(await reach(app)).toBeLessThan(330);
  expect(asked).toBe(false);
});

test('letter spacing spreads the text out', async ({ app }) => {
  // In the fallback alone: ten H's 0.6 em wide, each 10 further apart, reach past where they would end unspaced.
  await open(app, svg('').replace('font-size="50"', 'font-size="50" letter-spacing="10"'), 'spaced.svg');
  await expect.poll(() => reach(app)).toBeGreaterThan(370);
});
