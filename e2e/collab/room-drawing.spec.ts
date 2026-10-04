// A drawing in a room: everyone edits it at once, node by node, and each sees the others' changes as they are made.

import { test, expect, App } from '../fixtures';
import { importFile } from '../files/helpers';
import { getRoomLink } from './helpers';

const DRAWING = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
  <rect id="red" x="20" y="20" width="120" height="80" fill="#e53935"/>
  <circle id="green" cx="300" cy="100" r="60" fill="#43a047"/>
</svg>`;

const layers = (app: App) => app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');

/** Two people in one drawing: `a` opened it and shared it, `b` joined. */
async function drawingPair(browser: import('@playwright/test').Browser) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const a = new App(await context.newPage());
  await a.goto('?doc=welcome');
  await importFile(a, { name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(DRAWING) });
  await expect(layers(a)).toHaveCount(2, { timeout: 30_000 });
  const url = await getRoomLink(a);
  await expect(layers(a)).toHaveCount(2, { timeout: 30_000 });
  const b = new App(await context.newPage());
  await b.page.goto(url);
  await b.ready();
  await expect(layers(b)).toHaveCount(2, { timeout: 30_000 });
  return { context, a, b };
}

async function drawRectangle(app: App): Promise<void> {
  await app.toolbarButton('Rectangle').click();
  const box = await app.page.locator('.wm-vector-canvas').boundingBox();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await app.page.mouse.move(x - 40, y - 30);
  await app.page.mouse.down();
  await app.page.mouse.move(x, y);
  await app.page.mouse.move(x + 40, y + 30);
  await app.page.mouse.up();
}

test('a drawing can be shared: the one who joins opens the same drawing as a drawing', async ({ browser }) => {
  const { context, a, b } = await drawingPair(browser);
  await expect(b.page.getByRole('combobox', { name: 'Document format' })).toHaveValue(/SVG/);
  await context.close();
});

test('both draw at the same time, and every shape ends up on both drawings', async ({ browser }) => {
  const { context, a, b } = await drawingPair(browser);
  await drawRectangle(a);
  await drawRectangle(b);
  await expect(layers(a)).toHaveCount(4, { timeout: 30_000 });
  await expect(layers(b)).toHaveCount(4, { timeout: 30_000 });
  // The same shapes in the same order on both.
  const names = (app: App) => layers(app).allTextContents();
  await expect.poll(async () => JSON.stringify(await names(a))).toBe(JSON.stringify(await names(b)));
  await context.close();
});

test('what one person deletes goes from the other’s drawing too, and each person’s undo takes back only their own', async ({ browser }) => {
  const { context, a, b } = await drawingPair(browser);
  await drawRectangle(a);
  await expect(layers(b)).toHaveCount(3, { timeout: 30_000 });
  await drawRectangle(b);
  await expect(layers(a)).toHaveCount(4, { timeout: 30_000 });
  // b undoes its own rectangle: a's stays.
  await b.menu('Edit', 'Undo');
  await expect(layers(b)).toHaveCount(3, { timeout: 30_000 });
  await expect(layers(a)).toHaveCount(3, { timeout: 30_000 });
  // b picks the red shape and deletes it: it goes from a's too.
  await layers(b).filter({ hasText: 'red' }).click();
  await b.press('Delete');
  await expect(layers(b)).toHaveCount(2, { timeout: 30_000 });
  await expect(layers(a)).toHaveCount(2, { timeout: 30_000 });
  await expect(layers(a).filter({ hasText: 'red' })).toHaveCount(0);
  await context.close();
});

test('one person’s change to a shape reaches the other without losing what the other did', async ({ browser }) => {
  const { context, a, b } = await drawingPair(browser);
  // a draws; b recolours the green circle while a is still drawing.
  await drawRectangle(a);
  await layers(b).filter({ hasText: 'green' }).click();
  await b.press('Delete');
  await expect(layers(a)).toHaveCount(2, { timeout: 30_000 });
  await expect(layers(b)).toHaveCount(2, { timeout: 30_000 });
  expect((await layers(a).allTextContents()).some((t) => t.includes('green'))).toBe(false);
  await context.close();
});
