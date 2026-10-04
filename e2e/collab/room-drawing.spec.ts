// A drawing in a room: only one person at a time edits it (the lease), the others see each change as it is made, and
// can take over once the editor has gone.

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

test('a drawing can be shared: the first to join may edit, the other sees the drawing and is told who is editing', async ({ browser }) => {
  const { context, a, b } = await drawingPair(browser);
  await expect(b.page.getByRole('combobox', { name: 'Document format' })).toHaveValue(/SVG/);
  await expect(b.page.locator('.wm-lease')).toBeVisible();
  await expect(b.page.locator('.wm-lease').getByRole('button', { name: 'Take over' })).toBeVisible();
  await expect(a.page.locator('.wm-lease')).toBeHidden();
  await context.close();
});

test('what the editor draws appears for the other person, who cannot draw until they take over', async ({ browser }) => {
  const { context, a, b } = await drawingPair(browser);
  // The one who may not edit draws nothing.
  await drawRectangle(b);
  await expect(layers(b)).toHaveCount(2);
  // The one who may edit draws, and the other sees it.
  await drawRectangle(a);
  await expect(layers(a)).toHaveCount(3);
  await expect(layers(b)).toHaveCount(3, { timeout: 30_000 });
  await context.close();
});

test('taking over is refused while the editor is working, and once they have gone the other is alone and edits freely', async ({ browser }) => {
  const { context, a, b } = await drawingPair(browser);
  await drawRectangle(a);
  await expect(layers(b)).toHaveCount(3, { timeout: 30_000 });
  // The editor was working a moment ago: the lease stays with them.
  await b.page.locator('.wm-lease').getByRole('button', { name: 'Take over' }).click();
  await drawRectangle(b);
  await expect(layers(b)).toHaveCount(3);
  await expect(b.page.locator('.wm-lease')).toBeVisible();
  // They go: nobody else is here, so there is nothing to wait for.
  await a.page.close();
  await expect(b.page.locator('.wm-lease')).toBeHidden();
  await drawRectangle(b);
  await expect(layers(b)).toHaveCount(4);
  await context.close();
});
