import type { Page } from '@playwright/test';
import { expect, MOD, test, type App } from '../fixtures';
import { choose, isChecked, isMac, menuRow, openMenu, resize, stored } from './helpers';

const pagesInfo = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { pages: { x: number; y: number; width: number; height: number }[] };
    const canvas = document.getElementById('canvas')!;
    return { pages: w.pages.map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height })), canvasWidth: canvas.clientWidth };
  });

async function threePages(app: App): Promise<void> {
  await app.blank();
  await app.type('one');
  await app.press(`${MOD}+Enter`);
  await app.type('two');
  await app.press(`${MOD}+Enter`);
  await app.type('three');
  await expect.poll(async () => (await pagesInfo(app.page)).pages.length).toBe(3);
}

test.describe('formatting marks', () => {
  test('the toolbar button, View menu item and Ctrl+Shift+8 all toggle the marks together', async ({ app, page }) => {
    await app.blank();
    const button = app.toolbarButton('Formatting Marks');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await openMenu(app, 'View');
    expect(await isChecked(page, 'Formatting Marks')).toBe(true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await app.focus();
    await page.keyboard.press(`${MOD}+Shift+8`);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  test('the choice is remembered across a reload', async ({ app, page }) => {
    await app.blank();
    await app.toolbarButton('Formatting Marks').click();
    await expect.poll(() => stored(page, 'word.formattingMarks')).toBe('on');
    await page.reload();
    await app.ready();
    await expect(app.toolbarButton('Formatting Marks')).toHaveAttribute('aria-pressed', 'true');
    await app.toolbarButton('Formatting Marks').click();
    await expect.poll(() => stored(page, 'word.formattingMarks')).toBe('off');
    await page.reload();
    await app.ready();
    await expect(app.toolbarButton('Formatting Marks')).toHaveAttribute('aria-pressed', 'false');
  });

  test('the button keeps the keyboard in the document', async ({ app }) => {
    await app.blank();
    await app.toolbarButton('Formatting Marks').click();
    await expect(app.editor).toBeFocused();
    await app.page.keyboard.type('x');
    expect(await app.text()).toBe('x');
  });
});

test.describe('Print Layout and Flow views', () => {
  test('Print Layout is the default on a desktop window and Flow can be chosen', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await openMenu(app, 'View');
    expect(await isChecked(page, 'Print Layout')).toBe(true);
    expect(await isChecked(page, 'Flow')).toBe(false);
    await menuRow(page, 'Flow').click();
    await openMenu(app, 'View');
    expect(await isChecked(page, 'Flow')).toBe(true);
    expect(await isChecked(page, 'Print Layout')).toBe(false);
  });

  test('the choice is remembered in this browser', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await choose(app, 'View', 'Flow');
    await expect.poll(() => stored(page, 'word.viewMode')).toBe('flow');
    await page.reload();
    await app.ready();
    await openMenu(app, 'View');
    expect(await isChecked(page, 'Flow')).toBe(true);
    await menuRow(page, 'Print Layout').click();
    await expect.poll(() => stored(page, 'word.viewMode')).toBe('print');
  });

  test('Flow view reflows the text to the window width; Print Layout keeps the page size', async ({ app, page }) => {
    await app.blank();
    await app.type('Some text to lay out.');
    const print = await pagesInfo(page);
    await choose(app, 'View', 'Flow');
    await expect
      .poll(async () => {
        const n = await pagesInfo(page);
        return Math.abs(n.pages[0].width - n.canvasWidth / (await page.evaluate(() => (window as unknown as { camera: { zoom: number } }).camera.zoom)) / (96 / 72)) < 2;
      })
      .toBe(true);
    const flow = await pagesInfo(page);
    expect(flow.pages[0].width).not.toBeCloseTo(print.pages[0].width, 0);
    await choose(app, 'View', 'Print Layout');
    await expect.poll(async () => (await pagesInfo(page)).pages[0].width).toBeCloseTo(print.pages[0].width, 0);
  });

  test('resizing the window reflows a Flow view document', async ({ app, page }) => {
    await app.blank();
    await app.type('Reflow me when the window changes size.');
    await choose(app, 'View', 'Flow');
    // The text fills the window: the page is as wide (in points) as the canvas at the current zoom.
    const fills = async () => {
      const n = await pagesInfo(page);
      const z = await page.evaluate(() => (window as unknown as { camera: { zoom: number } }).camera.zoom);
      return Math.abs(n.pages[0].width - n.canvasWidth / z / (96 / 72)) < 2;
    };
    await expect.poll(fills, { timeout: 15_000 }).toBe(true);
    const wide = (await pagesInfo(page)).pages[0].width;
    await resize(page, 700, 800);
    await expect.poll(fills, { timeout: 15_000 }).toBe(true);
    const narrow = (await pagesInfo(page)).pages[0].width;
    expect(narrow).toBeLessThan(wide - 100);
    await resize(page, 1280, 800);
    await expect.poll(fills, { timeout: 15_000 }).toBe(true);
    expect((await pagesInfo(page)).pages[0].width).toBeGreaterThan(narrow + 100);
  });

  test('a phone-sized window starts in Flow view when nothing is saved', async ({ app, page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await app.goto('?doc=welcome');
    await page.getByRole('button', { name: 'Menu' }).click();
    const drawer = page.getByRole('dialog', { name: 'Menu' });
    await expect(drawer.getByRole('menuitemradio', { name: /^Flow/ })).toHaveAttribute('aria-checked', 'true');
    await expect(drawer.getByRole('menuitemradio', { name: /^Print Layout/ })).toHaveAttribute('aria-checked', 'false');
  });
});

test.describe('Page Grid', () => {
  test('toggles from the menu and with Alt+G, and lays pages out side by side', async ({ app, page }) => {
    await threePages(app);
    await choose(app, 'View', 'Zoom', 'Whole Page');
    const before = (await pagesInfo(page)).pages;
    expect(new Set(before.map((p) => p.y)).size).toBe(3); // one column
    await choose(app, 'View', 'Page Grid');
    await expect.poll(async () => new Set((await pagesInfo(page)).pages.map((p) => p.y)).size, { message: 'pages share a row' }).toBeLessThan(3);
    await openMenu(app, 'View');
    expect(await isChecked(page, 'Page Grid')).toBe(true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await app.focus();
    await page.keyboard.press('Alt+g');
    await expect.poll(async () => new Set((await pagesInfo(page)).pages.map((p) => p.y)).size).toBe(3);
    await openMenu(app, 'View');
    expect(await isChecked(page, 'Page Grid')).toBe(false);
  });

  test('the menu shows the Alt+G shortcut', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await openMenu(app, 'View');
    await expect(menuRow(page, 'Page Grid').locator('.wm-shortcut')).toHaveText((await isMac(page)) ? '⌥G' : 'Alt+G');
  });
});

test.describe('Ruler', () => {
  test('View > Ruler shows a ruler above the page, ticks the item, and hides again', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    const ruler = page.locator('#ruler');
    await expect(ruler).toBeHidden();
    await openMenu(app, 'View');
    await expect(menuRow(page, 'Ruler')).toHaveAttribute('role', 'menuitemcheckbox');
    await menuRow(page, 'Ruler').click();
    await expect(ruler).toBeVisible();
    await expect(ruler.locator('canvas')).toBeVisible();
    await expect(page.locator('#vruler canvas')).toBeVisible();
    await openMenu(app, 'View');
    expect(await isChecked(page, 'Ruler')).toBe(true);
    await menuRow(page, 'Ruler').click();
    await expect(ruler).toBeHidden();
  });
});

test.describe('toolbars', () => {
  test('View > Toolbars hides and shows a toolbar, and the state is ticked in the menu', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    const formatting = page.getByRole('toolbar', { name: 'Formatting' });
    await expect(formatting).toBeVisible();
    await openMenu(app, 'View');
    await menuRow(page, 'Toolbars').hover();
    expect(await isChecked(page, 'Formatting')).toBe(true);
    await menuRow(page, 'Formatting').click();
    await expect(formatting).toBeHidden();
    await expect(page.getByRole('toolbar', { name: 'Standard' })).toBeVisible();
    await openMenu(app, 'View');
    await menuRow(page, 'Toolbars').hover();
    expect(await isChecked(page, 'Formatting')).toBe(false);
    await menuRow(page, 'Formatting').click();
    await expect(formatting).toBeVisible();
  });

  test('a hidden toolbar stays hidden after a reload', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await choose(app, 'View', 'Toolbars', 'Standard');
    await expect(page.getByRole('toolbar', { name: 'Standard' })).toBeHidden();
    await page.reload();
    await app.ready();
    await expect(page.getByRole('toolbar', { name: 'Standard' })).toBeHidden();
    await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
  });

  test('the Picture and Draw toolbars only exist for pictures', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await expect(page.getByRole('toolbar', { name: 'Picture' })).toBeHidden();
    await expect(page.getByRole('toolbar', { name: 'Draw' })).toBeHidden();
  });
});

test.describe('Full Screen', () => {
  test('View > Full Screen enters full screen and leaving it returns', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    test.skip(!(await page.evaluate(() => document.fullscreenEnabled)), 'this browser cannot go full screen');
    await choose(app, 'View', 'Full Screen');
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    // The menu bar is hidden while full screen (Esc leaves it): the browser's own exit stands in for the key.
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await openMenu(app, 'View');
    expect(await isChecked(page, 'Full Screen')).toBe(false);
  });
});

test.describe('Show Toolbars', () => {
  test('View › Toolbars › Show Toolbars hides and shows every toolbar, and the choice is remembered', async ({ app, page }) => {
    await app.blank();
    const toolbars = page.locator('.wm-toolbars');
    await expect(toolbars).toBeVisible();
    await app.menu('View', 'Toolbars', 'Show Toolbars');
    await expect(toolbars).toBeHidden();
    await page.reload();
    await app.ready();
    await expect(toolbars).toBeHidden();
    await app.menu('View', 'Toolbars', 'Show Toolbars');
    await expect(toolbars).toBeVisible();
  });
});

test.describe('Full Screen', () => {
  const leave = (page: import('@playwright/test').Page) => page.evaluate(() => document.exitFullscreen());

  test('hides the menus, toolbars and status bar, says how to leave, and brings them back on leaving', async ({ app, page }) => {
    await app.blank();
    await expect(page.locator('#chrome')).toBeVisible();
    await app.menu('View', 'Full Screen');
    await expect(page.locator('body.wm-fullscreen')).toHaveCount(1);
    await expect(page.locator('#chrome')).toBeHidden();
    await expect(page.locator('#footer')).toBeHidden();
    await expect(page.getByRole('alert').filter({ hasText: 'Esc' })).toBeVisible();
    await leave(page);
    await expect(page.locator('body.wm-fullscreen')).toHaveCount(0);
    await expect(page.locator('#chrome')).toBeVisible();
  });

  test('keeps the menu bar, and hides only the toolbars, when Options says so', async ({ app, page }) => {
    await app.blank();
    await app.menu('Tools', 'Options');
    await page.getByRole('checkbox', { name: 'Keep the menu bar in full screen' }).check();
    await page.keyboard.press('Escape');
    await app.menu('View', 'Full Screen');
    await expect(page.locator('body.wm-fullscreen')).toHaveCount(1);
    await expect(page.locator('#chrome')).toBeVisible();
    await expect(page.locator('.wm-toolbars')).toBeHidden();
    await expect(page.locator('.wm-menubar').first()).toBeVisible();
    await leave(page);
    await expect(page.locator('.wm-toolbars')).toBeVisible();
  });
});
