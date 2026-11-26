// Shapes on a slide with the pointer (docs/architecture/drawingml.md): Insert › Shape's picker, then the shape moved by
// dragging, sized by its corner handle, its text typed after a double click, and its fill from the context menu. These run
// through DrawingML's ShapeEditor, which the slides editor drives.

import type { Page } from '@playwright/test';
import { MOD, expect, test } from '../files/fixtures';
import { dropFile, fixture, waitForOpen } from '../files/helpers';

interface SlidesState {
  slides: { shapes: { name: string; text: string; x: number; y: number }[] }[];
  current: number;
  selected: string[];
  editing: unknown;
  canUndo: boolean;
}

interface Screen {
  x: number;
  y: number;
  corner: { x: number; y: number };
}

const state = (page: Page): Promise<SlidesState> => page.evaluate(() => (window as unknown as { slidesEditor: { state(): SlidesState } }).slidesEditor.state());
const screenOf = (page: Page, name: string): Promise<Screen | null> => page.evaluate((n) => (window as unknown as { slidesEditor: { screenOf(n: string): Screen | null } }).slidesEditor.screenOf(n), name);
const shape = async (page: Page, name: string) => (await state(page)).slides[0].shapes.find((s) => s.name === name);

async function open(app: Parameters<typeof waitForOpen>[0], page: Page): Promise<void> {
  await app.goto('?doc=welcome');
  await dropFile(page, { ...fixture('slides/review.pptx'), name: 'review.pptx' });
  await waitForOpen(app, 'review.pptx');
  await expect.poll(async () => (await state(page))?.slides.length, { timeout: 20_000 }).toBe(2);
}

test('Insert › Shape offers the shapes with their pictures, and the one picked is put on the slide', async ({ app, page }) => {
  await open(app, page);
  await app.menu('Insert', 'Shape');
  const menu = page.getByRole('menu', { name: 'Shape' });
  // The same shapes and names as the drawing tools' list, each with its picture, in groups.
  await expect(menu.getByRole('menuitem', { name: 'Rectangle', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '4-Point Star' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Heart' }).locator('svg.wm-shape-preview')).toBeVisible();
  expect(await menu.getByRole('separator').count()).toBeGreaterThanOrEqual(4);
  await menu.getByRole('menuitem', { name: 'Heart' }).click();
  await expect.poll(async () => (await state(page)).selected).toEqual(['Heart']);
});

test('a shape is moved by dragging, sized by its corner, and typed into after a double click', async ({ app, page }) => {
  await open(app, page);
  await app.menu('Insert', 'Shape');
  await page.getByRole('menu', { name: 'Shape' }).getByRole('menuitem', { name: 'Rectangle', exact: true }).click();
  await expect.poll(async () => (await state(page)).selected).toEqual(['Rectangle']);
  const canvas = (await page.locator('#canvas').boundingBox())!;
  const before = (await shape(page, 'Rectangle'))!;

  // Dragged by its middle (a press on a shape already selected would edit its text, so it is let go first): it moves right and down.
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).selected).toEqual([]);
  let at = (await screenOf(page, 'Rectangle'))!;
  await page.mouse.move(canvas.x + at.x, canvas.y + at.y);
  await page.mouse.down();
  await page.mouse.move(canvas.x + at.x + 40, canvas.y + at.y + 30, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await shape(page, 'Rectangle'))!.x).toBeGreaterThan(before.x);
  const moved = (await shape(page, 'Rectangle'))!;
  expect(moved.y).toBeGreaterThan(before.y);

  // Its bottom right handle drags the corner out; the top left stays.
  at = (await screenOf(page, 'Rectangle'))!;
  await page.mouse.move(canvas.x + at.corner.x, canvas.y + at.corner.y);
  await page.mouse.down();
  await page.mouse.move(canvas.x + at.corner.x + 30, canvas.y + at.corner.y + 20, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await screenOf(page, 'Rectangle'))!.corner.x).toBeGreaterThan(at.corner.x + 20);
  expect((await shape(page, 'Rectangle'))!.x).toBe(moved.x);

  // A double click edits its text in place.
  at = (await screenOf(page, 'Rectangle'))!;
  await page.mouse.dblclick(canvas.x + at.x, canvas.y + at.y);
  await expect.poll(async () => (await state(page)).editing).not.toBeNull();
  await page.keyboard.type('Inside');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await shape(page, 'Rectangle'))!.text).toBe('Inside');
  expect((await state(page)).selected).toEqual(['Rectangle']);
});

test("a shape's fill is set from its context menu", async ({ app, page }) => {
  await open(app, page);
  await app.menu('Insert', 'Shape');
  await page.getByRole('menu', { name: 'Shape' }).getByRole('menuitem', { name: 'Oval', exact: true }).click();
  const canvas = (await page.locator('#canvas').boundingBox())!;
  const at = (await screenOf(page, 'Oval'))!;
  await page.mouse.click(canvas.x + at.x, canvas.y + at.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Fill', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Accent 2/ }).click();
  // The fill is its own step: the first undo takes it back and leaves the oval, the second takes the oval away.
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await state(page)).canUndo).toBe(true);
  expect(await shape(page, 'Oval')).toBeTruthy();
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => await shape(page, 'Oval')).toBeUndefined();
});
