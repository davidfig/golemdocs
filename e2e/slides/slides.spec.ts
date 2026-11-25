// The slides editor (docs/slides.md): a deck opens in it, its title is typed into, shapes are moved, slides are added and put
// in order, it is presented, and it downloads as .pptx with the changes. The slides are painted on a canvas, so the specs read
// the editor through `window.slidesEditor` (see main.ts) and click where it says shapes are.

import type { Page } from '@playwright/test';
import { MOD, expect, test } from '../files/fixtures';
import { dropFile, fixture, readZip, waitForOpen } from '../files/helpers';

interface SlidesState {
  slides: { name: string; title: string; hidden: boolean; layout: string; shapes: { name: string; text: string; x: number; y: number }[] }[];
  current: number;
  selected: string[];
  editing: unknown;
  sorter: boolean;
  canUndo: boolean;
  presenting: number | null;
}

const state = (page: Page): Promise<SlidesState> => page.evaluate(() => (window as unknown as { slidesEditor: { state(): SlidesState } }).slidesEditor.state());

async function open(app: Parameters<typeof waitForOpen>[0], page: Page): Promise<void> {
  await app.goto('?doc=welcome');
  await dropFile(page, { ...fixture('slides/review.pptx'), name: 'review.pptx' });
  await waitForOpen(app, 'review.pptx');
  await expect.poll(async () => (await state(page))?.slides.length, { timeout: 20_000 }).toBe(2);
}

/** Clicks the middle of a shape of the slide in hand, by name. */
async function clickShape(page: Page, name: string, clicks = 1): Promise<void> {
  const at = await page.evaluate((n) => (window as unknown as { slidesEditor: { screenOf(n: string): { x: number; y: number } | null } }).slidesEditor.screenOf(n), name);
  if (!at) throw new Error(`no shape ${name} on screen`);
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(box.x + at.x, box.y + at.y, { clickCount: clicks });
}

test('a deck opens in the slides editor, with its slides and the Slide menu', async ({ app, page }) => {
  await open(app, page);
  const s = await state(page);
  expect(s.slides.map((x) => x.title)).toEqual(['Quarterly review', 'Next steps']);
  await expect(page.getByRole('menubar').getByRole('menuitem', { name: 'Slide' })).toBeVisible();
});

test('typing into the title, then undo', async ({ app, page }) => {
  await open(app, page);
  await clickShape(page, 'Title 1', 2);
  await expect.poll(async () => (await state(page)).editing).not.toBeNull();
  await page.keyboard.press('End');
  await page.keyboard.type(' 2026');
  await expect.poll(async () => (await state(page)).slides[0].title).toBe('Quarterly review 2026');
  await page.keyboard.press('Escape');
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await state(page)).slides[0].title).toBe('Quarterly review');
});

test('a shape is moved with the arrow keys after Tab selects it', async ({ app, page }) => {
  await open(app, page);
  await page.locator('#canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await state(page)).selected.length).toBe(1);
  const name = (await state(page)).selected[0];
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await state(page)).slides[0].shapes.find((x) => x.name === name)?.x).toBeGreaterThan(0);
});

test('slides are added, moved and deleted from the Slide menu', async ({ app, page }) => {
  await open(app, page);
  await app.menu('Slide', 'New Slide');
  await expect.poll(async () => (await state(page)).slides.length).toBe(3);
  expect((await state(page)).current).toBe(1);
  await app.menu('Slide', 'Move Slide Down');
  await expect.poll(async () => (await state(page)).slides.map((x) => x.title)).toEqual(['Quarterly review', 'Next steps', '']);
  await app.menu('Slide', 'Delete Slide');
  await expect.poll(async () => (await state(page)).slides.length).toBe(2);
});

test('Slide Sorter shows every slide, and a show runs and ends with Escape', async ({ app, page }) => {
  await open(app, page);
  await app.menu('View', 'Slide Sorter');
  await expect.poll(async () => (await state(page)).sorter).toBe(true);
  await app.menu('View', 'Slide Sorter');
  await app.menu('Slide', 'Present from Beginning');
  await expect.poll(async () => (await state(page)).presenting).toBe(0);
  await expect(page.getByRole('dialog', { name: 'Slide show' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await state(page)).presenting).toBe(1);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).presenting).toBe(null);
  expect((await state(page)).current).toBe(1);
});

test('the deck downloads as .pptx with what was typed', async ({ app, page }) => {
  await open(app, page);
  await clickShape(page, 'Title 1', 2);
  await page.keyboard.press('End');
  await page.keyboard.type(' — final');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).canUndo).toBe(true);
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('review.pptx');
  const parts = readZip(file.bytes);
  const slide = parts.find((p) => p.name === 'ppt/slides/slide2.xml');
  expect(slide?.bytes.toString('utf8')).toContain('Quarterly review — final');
  expect(parts.some((p) => p.name === 'ppt/presentation.xml')).toBe(true);
});
