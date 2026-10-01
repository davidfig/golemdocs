import type { Page } from '@playwright/test';
import { expect, MOD, test, type App } from '../fixtures';
import { blankReady, camera, choose, expectZoom, isChecked, menuRow, openMenu, zoom } from './helpers';

const CSS_PX_PER_POINT = 96 / 72;

const zoomBox = (page: Page) => page.getByRole('toolbar').getByRole('combobox', { name: 'Zoom' });

/** A blank document three pages long. */
async function threePages(app: App): Promise<void> {
  await blankReady(app);
  await app.type('one');
  await app.press(`${MOD}+Enter`);
  await app.type('two');
  await app.press(`${MOD}+Enter`);
  await app.type('three');
  await expect.poll(() => app.page.evaluate(() => (window as unknown as { pages: unknown[] }).pages.length)).toBe(3);
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { pages: { x: number; y: number; width: number; height: number }[]; camera: { zoom: number } };
    const canvas = document.getElementById('canvas')!;
    return { page: { width: w.pages[0].width, height: w.pages[0].height }, pages: w.pages.length, view: { width: canvas.clientWidth, height: canvas.clientHeight } };
  });
}

test.describe('zoom from the View menu', () => {
  test('Actual Size is 100%, and the Zoom menu ticks the preset in use', async ({ app, page }) => {
    await blankReady(app);
    await choose(app, 'View', 'Zoom', '200%');
    expect(await expectZoom(page, (z) => Math.abs(z - 2) < 0.005)).toBeCloseTo(2, 2);
    await openMenu(app, 'View');
    await menuRow(page, 'Zoom').hover();
    expect(await isChecked(page, '200%')).toBe(true);
    expect(await isChecked(page, '100%')).toBe(false);
    await menuRow(page, 'Actual Size').click();
    expect(await expectZoom(page, (z) => Math.abs(z - 1) < 0.005)).toBeCloseTo(1, 2);
  });

  test('each percentage preset sets that zoom', async ({ app, page }) => {
    await blankReady(app);
    for (const [label, value] of [['500%', 5], ['75%', 0.75], ['25%', 0.25], ['10%', 0.1], ['150%', 1.5]] as const) {
      await choose(app, 'View', 'Zoom', label);
      await expectZoom(page, (z) => Math.abs(z - value) < 0.005, label);
    }
  });

  test('Zoom In and Zoom Out scale by a quarter steps from the current zoom', async ({ app, page }) => {
    await blankReady(app);
    await choose(app, 'View', 'Zoom', 'Actual Size');
    await expectZoom(page, (z) => Math.abs(z - 1) < 0.005);
    await choose(app, 'View', 'Zoom', 'Zoom In');
    expect(await expectZoom(page, (z) => Math.abs(z - 1.25) < 0.005)).toBeCloseTo(1.25, 2);
    await choose(app, 'View', 'Zoom', 'Zoom Out');
    await choose(app, 'View', 'Zoom', 'Zoom Out');
    expect(await expectZoom(page, (z) => Math.abs(z - 0.8) < 0.005)).toBeCloseTo(0.8, 2);
  });

  test('Page Width fills the window with the page, less a margin', async ({ app, page }) => {
    await blankReady(app);
    await choose(app, 'View', 'Zoom', 'Page Width');
    const g = await geometry(page);
    const expected = (g.view.width - 32) / (g.page.width * CSS_PX_PER_POINT);
    await expectZoom(page, (z) => Math.abs(z - expected) < 0.01, 'page width zoom');
  });

  test('Whole Page fits one page inside the window', async ({ app, page }) => {
    await blankReady(app);
    await choose(app, 'View', 'Zoom', 'Whole Page');
    const g = await geometry(page);
    const z = await expectZoom(page, (value) => value * g.page.height * CSS_PX_PER_POINT <= g.view.height && value * g.page.width * CSS_PX_PER_POINT <= g.view.width);
    // ...and is not much smaller than the window allows.
    expect(z * g.page.height * CSS_PX_PER_POINT).toBeGreaterThan(g.view.height - 40);
  });

  test('All Pages zooms out to show every page, further than Whole Page', async ({ app, page }) => {
    await threePages(app);
    await choose(app, 'View', 'Zoom', 'Whole Page');
    const whole = await zoom(page);
    await choose(app, 'View', 'Zoom', 'All Pages');
    await expectZoom(page, (z) => z < whole * 0.9, 'all pages zoom');
  });

  test('the zoom box shows the current zoom and follows the menu', async ({ app, page }) => {
    await blankReady(app);
    await choose(app, 'View', 'Zoom', '75%');
    await expect(zoomBox(page)).toHaveValue('75%');
    await choose(app, 'View', 'Zoom', 'Actual Size');
    await expect(zoomBox(page)).toHaveValue('100%');
  });
});

test.describe('zoom box', { tag: '@heavy' }, () => {
  test('typing a percentage and pressing Enter zooms, and the document keeps the keyboard', async ({ app, page }) => {
    await blankReady(app);
    await zoomBox(page).fill('150');
    await expect(zoomBox(page)).toHaveValue('150');
    await zoomBox(page).press('Enter');
    await expectZoom(page, (z) => Math.abs(z - 1.5) < 0.005);
    await expect(zoomBox(page)).toHaveValue('150%');
    await expect(app.editor).toBeFocused();
  });

  test('typing a percent sign works too', async ({ app, page }) => {
    await blankReady(app);
    await zoomBox(page).fill('50%');
    await expect(zoomBox(page)).toHaveValue('50%');
    await zoomBox(page).press('Enter');
    await expectZoom(page, (z) => Math.abs(z - 0.5) < 0.005);
  });

  test('typing a preset name (Page Width) applies it', async ({ app, page }) => {
    await blankReady(app);
    await choose(app, 'View', 'Zoom', '500%');
    await zoomBox(page).fill('page width');
    await expect(zoomBox(page)).toHaveValue('page width');
    await zoomBox(page).press('Enter');
    const g = await geometry(page);
    const expected = (g.view.width - 32) / (g.page.width * CSS_PX_PER_POINT);
    await expectZoom(page, (z) => Math.abs(z - expected) < 0.01);
  });

  test('text that is not a zoom goes back to the current value', async ({ app, page }) => {
    await blankReady(app);
    const before = await zoom(page);
    await zoomBox(page).fill('banana');
    await expect(zoomBox(page)).toHaveValue('banana');
    await zoomBox(page).press('Enter');
    await expect(zoomBox(page)).toHaveValue(`${Math.round(before * 100)}%`);
    expect(await zoom(page)).toBeCloseTo(before, 5);
  });

  test('the drop-down lists the presets and picking one zooms', async ({ app, page }) => {
    await blankReady(app);
    await page.getByRole('button', { name: 'Zoom list' }).first().click();
    const list = page.getByRole('listbox', { name: 'Zoom' });
    await expect(list.getByRole('option')).toHaveText(['500%', '200%', '150%', '100%', '75%', '50%', '25%', '10%', 'Page Width', 'Whole Page', 'All Pages']);
    await list.getByRole('option', { name: '200%' }).click();
    await expectZoom(page, (z) => Math.abs(z - 2) < 0.005);
    await expect(list).toHaveCount(0);
    await expect(app.editor).toBeFocused();
  });

  test('Escape in the drop-down closes it without changing the zoom', async ({ app, page }) => {
    await blankReady(app);
    const before = await zoom(page);
    await page.getByRole('button', { name: 'Zoom list' }).first().click();
    await expect(page.getByRole('listbox', { name: 'Zoom' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox', { name: 'Zoom' })).toHaveCount(0);
    expect(await zoom(page)).toBeCloseTo(before, 5);
  });
});

test.describe('zoom with the keyboard and pointer', () => {
  test('Ctrl/Cmd + = and - zoom in and out, Ctrl/Cmd + 0 is Actual Size', async ({ app, page }) => {
    await blankReady(app);
    await page.keyboard.press(`${MOD}+0`);
    await expectZoom(page, (z) => Math.abs(z - 1) < 0.005);
    await page.keyboard.press(`${MOD}+=`);
    await expectZoom(page, (z) => Math.abs(z - 1.25) < 0.005, 'zoom in');
    await page.keyboard.press(`${MOD}+-`);
    await page.keyboard.press(`${MOD}+-`);
    await expectZoom(page, (z) => Math.abs(z - 0.8) < 0.005, 'zoom out');
    await page.keyboard.press(`${MOD}+0`);
    await expectZoom(page, (z) => Math.abs(z - 1) < 0.005, 'actual size');
  });

  test('Ctrl + wheel (and so a trackpad pinch) zooms about the pointer', async ({ app, page }) => {
    await blankReady(app);
    await page.keyboard.press(`${MOD}+0`);
    await expectZoom(page, (z) => Math.abs(z - 1) < 0.005);
    await page.mouse.move(640, 400);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -30);
    await page.keyboard.up('Control');
    await expectZoom(page, (z) => z > 1.2, 'wheel zoom in');
    await page.waitForTimeout(250); // a new wheel gesture: the gap after the last event
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 60);
    await page.keyboard.up('Control');
    await expectZoom(page, (z) => z < 1.0, 'wheel zoom out');
  });

  test('a plain wheel scrolls instead of zooming', async ({ app, page }) => {
    await threePages(app);
    await choose(app, 'View', 'Zoom', '100%');
    await page.mouse.move(640, 400);
    const before = await camera(page);
    await page.mouse.wheel(0, 300);
    await expect.poll(async () => (await camera(page)).y).toBeGreaterThan(before.y + 100);
    expect((await camera(page)).zoom).toBeCloseTo(before.zoom, 5);
    const down = (await camera(page)).y;
    await page.mouse.wheel(0, -150);
    await expect.poll(async () => (await camera(page)).y).toBeLessThan(down);
  });

  test('the view cannot be scrolled far past the ends of the document', async ({ app, page }) => {
    await threePages(app);
    await choose(app, 'View', 'Zoom', '100%');
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 100000);
    await expect.poll(async () => (await camera(page)).y).toBeGreaterThan(500);
    const end = (await camera(page)).y;
    const g = await geometry(page);
    // The last page's bottom is about at the window's bottom edge (plus a small padding).
    const pagesBottom = await page.evaluate(() => {
      const p = (window as unknown as { pages: { y: number; height: number }[] }).pages;
      return p[p.length - 1].y + p[p.length - 1].height;
    });
    expect(end + g.view.height / CSS_PX_PER_POINT).toBeLessThan(pagesBottom + 60);
  });
});
