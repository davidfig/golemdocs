import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { openMenu, menuRow } from '../shell/helpers';
import { readPageSetup } from './helpers';

/** Where a point of the first page is on the screen (CSS pixels, window coordinates). */
const screenOf = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      const w = window as unknown as { camera: { x: number; y: number; zoom: number } };
      const box = document.getElementById('canvas')!.getBoundingClientRect();
      const scale = w.camera.zoom * (96 / 72);
      return { x: box.left + (px - w.camera.x) * scale, y: box.top + (py - w.camera.y) * scale, scale };
    },
    [x, y],
  );

test.describe('Ruler markers', () => {
  test.beforeEach(async ({ app, page }) => {
    await app.blank();
    await app.type('Hello');
    await openMenu(app, 'View');
    await menuRow(page, 'Ruler').click();
    await expect(page.locator('#ruler canvas')).toBeVisible();
  });

  test('dragging the left margin edge on the ruler changes the page margin', async ({ app, page }) => {
    const edge = await screenOf(page, 72, 0);
    const strip = (await page.locator('#ruler canvas').boundingBox())!;
    const y = strip.y + 10; // between the indent markers
    await page.mouse.move(edge.x, y);
    await page.mouse.down();
    await page.mouse.move(edge.x + 72 * edge.scale * 0.5, y, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await readPageSetup(app)).left).toBeCloseTo(1.5, 1);
  });

  test('dragging the first-line marker indents the first line of the paragraph', async ({ app, page }) => {
    const start = await screenOf(page, 72, 0);
    const strip = (await page.locator('#ruler canvas').boundingBox())!;
    await page.mouse.move(start.x, strip.y + 3);
    await page.mouse.down();
    await page.mouse.move(start.x + 36 * start.scale, strip.y + 3, { steps: 5 });
    await page.mouse.up();
    await app.menu('Format', 'Paragraph…');
    const dlg = page.getByRole('dialog', { name: 'Paragraph' });
    await expect(dlg.getByRole('combobox', { name: 'Special' })).toHaveValue('firstLine');
    await expect(dlg.getByRole('spinbutton', { name: 'By' })).toHaveValue('0.5');
  });
});

test('dragging the top margin edge on the vertical ruler changes the top margin', async ({ app, page }) => {
  await app.blank();
  await app.type('Hello');
  await openMenu(app, 'View');
  await menuRow(page, 'Ruler').click();
  await expect(page.locator('#vruler canvas')).toBeVisible();
  const edge = await screenOf(page, 0, 72);
  const strip = (await page.locator('#vruler canvas').boundingBox())!;
  const x = strip.x + 10;
  await page.mouse.move(x, edge.y);
  await page.mouse.down();
  await page.mouse.move(x, edge.y + 72 * edge.scale * 0.5, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await readPageSetup(app)).top).toBeCloseTo(1.5, 1);
});
