// A picture in a room: the shapes drawn over it are its layers, shared object by object, so several people can draw at once; undo
// takes back only one's own shape; and changes to the picture itself (which make a new picture) are not available while others are here.

import { test, expect, App } from '../fixtures';
import { currentPicture, expectPicture, isReddish, isWhite, makePng, openPicture, pictureToScreen, pixelAt } from '../layout/helpers';
import { getRoomLink } from './helpers';

const W = 400;
const H = 300;
const CANVAS = () => makePng(W, H, () => [255, 255, 255, 255]);

/** How many pixels in a box of the picture are not white. */
function inked(img: { width: number; data: Uint8Array }, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!isWhite(pixelAt(img, x, y))) n++;
  return n;
}

const shapesOf = (app: App) => app.page.evaluate(() => (window as unknown as { pictureShapes: { tool: string }[] }).pictureShapes.filter((s) => s.tool !== 'group').map((s) => s.tool));

async function drag(app: App, from: [number, number], to: [number, number]): Promise<void> {
  const a = await pictureToScreen(app.page, W, ...from);
  const b = await pictureToScreen(app.page, W, ...to);
  await app.page.mouse.move(a.x, a.y);
  await app.page.mouse.down();
  await app.page.mouse.move(b.x, b.y, { steps: 6 });
  await app.page.mouse.up();
}

/** Two people on one picture: `a` opened it and shared it, `b` joined. */
async function picturePair(browser: import('@playwright/test').Browser) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const a = new App(await context.newPage());
  await openPicture(a, CANVAS());
  const url = await getRoomLink(a);
  const b = new App(await context.newPage());
  await b.page.goto(url);
  await b.ready();
  await expect(b.page.getByRole('combobox', { name: 'Document format' })).toHaveValue(/PNG/);
  return { context, a, b };
}

test('a picture can be shared, and what one person draws over it appears for the other', async ({ browser }) => {
  const { context, a, b } = await picturePair(browser);
  await a.toolbarButton(/^Line$/).click();
  await drag(a, [40, 40], [240, 40]);
  await expect.poll(() => shapesOf(b), { timeout: 30_000 }).toEqual(['line']);
  await context.close();
});

test('both can draw at once, and every shape ends up on both pictures, and in the picture each would save', async ({ browser }) => {
  const { context, a, b } = await picturePair(browser);
  await a.toolbarButton(/^Line$/).click();
  await b.toolbarButton(/^Rectangle$/).click();
  await drag(a, [40, 40], [240, 40]);
  await drag(b, [40, 150], [240, 250]);
  await expect.poll(async () => (await shapesOf(a)).sort(), { timeout: 30_000 }).toEqual(['line', 'rectangle']);
  await expect.poll(async () => (await shapesOf(b)).sort(), { timeout: 30_000 }).toEqual(['line', 'rectangle']);
  for (const app of [a, b]) await expectPicture(app, (i) => isReddish(pixelAt(i, 140, 40)) && isReddish(pixelAt(i, 40, 200)));
  await context.close();
});

test('undo takes back only the person’s own shape', async ({ browser }) => {
  const { context, a, b } = await picturePair(browser);
  await a.toolbarButton(/^Line$/).click();
  await drag(a, [40, 40], [240, 40]);
  await b.toolbarButton(/^Rectangle$/).click();
  await expect.poll(() => shapesOf(b), { timeout: 30_000 }).toEqual(['line']);
  await drag(b, [40, 150], [240, 250]);
  await expect.poll(async () => (await shapesOf(a)).length, { timeout: 30_000 }).toBe(2);
  await b.menu('Edit', 'Undo');
  await expect.poll(() => shapesOf(b), { timeout: 30_000 }).toEqual(['line']);
  await expect.poll(() => shapesOf(a), { timeout: 30_000 }).toEqual(['line']);
  await context.close();
});

test('the picture itself cannot be changed while others are here, and the person is told', async ({ browser }) => {
  const { context, a } = await picturePair(browser);
  await a.menu('Picture', 'Rotate Right');
  await expect.poll(() => a.page.evaluate(() => (window as unknown as { status: string }).status)).toContain('aren’t available while others are editing it');
  expect(inked(await currentPicture(a), 0, 0, W, H)).toBe(0);
  await context.close();
});
