import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { DESKTOP, PHONE, TABLET, menuTitle, resize } from './helpers';

const hamburger = (page: Page) => page.getByRole('button', { name: 'Menu' });
const drawer = (page: Page) => page.getByRole('dialog', { name: 'Menu' });
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);

test.describe('desktop layout', () => {
  test('shows the menu titles and both toolbars, no hamburger', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    for (const title of ['File', 'Edit', 'View', 'Insert', 'Format', 'Tools', 'Table', 'Help']) await expect(menuTitle(app, title)).toBeVisible();
    await expect(hamburger(page)).toBeHidden();
    await expect(page.getByRole('toolbar', { name: 'Standard' })).toBeVisible();
    await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'More buttons' })).toHaveCount(0);
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('the canvas fills the window under the chrome', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    const canvas = (await app.canvas.boundingBox())!;
    // The Page Sidebar is open by default on a wide window: the canvas fills what is right of it.
    expect(canvas.x + canvas.width).toBeCloseTo(DESKTOP.width, 0);
    const chrome = (await page.locator('#chrome').boundingBox())!;
    expect(canvas.y).toBeGreaterThanOrEqual(chrome.y + chrome.height - 2);
    expect(canvas.y + canvas.height).toBeLessThanOrEqual(DESKTOP.height + 1);
  });
});

test.describe('tablet layout', () => {
  test('keeps the desktop menu bar and toolbars', async ({ app, page }) => {
    await page.setViewportSize(TABLET);
    await app.goto('?doc=welcome');
    await expect(menuTitle(app, 'File')).toBeVisible();
    await expect(hamburger(page)).toBeHidden();
    await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('the switch to the phone layout happens at 720 px', async ({ app, page }) => {
    await page.setViewportSize({ width: 721, height: 900 });
    await app.goto('?doc=welcome');
    await expect(menuTitle(app, 'File')).toBeVisible();
    await resize(page, 720, 900);
    await expect(menuTitle(app, 'File')).toBeHidden();
    await expect(hamburger(page)).toBeVisible();
  });
});

test.describe('phone layout', () => {
  test('one hamburger replaces the menu titles, a file row replaces the toolbars, and a typing bar shows once the caret is down', async ({ app, page }) => {
    await page.setViewportSize(PHONE);
    await app.goto('?doc=welcome');
    await expect(hamburger(page)).toBeVisible();
    await expect(menuTitle(app, 'File')).toBeHidden();
    // The top row is for the file; the formatting buttons wait for the caret.
    const toolbars = page.getByRole('toolbar');
    await expect(toolbars).toHaveCount(1);
    for (const name of ['Undo', 'Redo']) await expect(toolbars.getByRole('button', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeHidden();
    expect(await noHorizontalScroll(page)).toBe(true);
    // Putting the caret in the document brings up the typing bar above the keyboard.
    await app.canvas.click({ position: { x: 100, y: 200 } });
    await expect(toolbars).toHaveCount(2);
    for (const name of ['Bold', 'Italic', 'Underline', 'Bullets', 'Numbering']) await expect(page.locator('.wm-keys').getByRole('button', { name, exact: true })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('buttons that do not fit go behind a "…" button that opens a panel of them', async ({ app, page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await app.goto('?doc=welcome');
    const toolbar = page.getByRole('toolbar');
    const more = toolbar.getByRole('button', { name: 'More buttons' });
    await expect(more).toBeVisible();
    // The bar itself does not scroll sideways: what doesn't fit moved into the panel.
    expect(await toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await more.click();
    const panel = page.locator('.wm-overflow');
    await expect(panel).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(await panel.getByRole('button').count()).toBeGreaterThan(5);
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });

  test('a button inside the overflow panel works and closes the panel', async ({ app, page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await app.goto('?doc=welcome');
    await page.getByRole('toolbar').getByRole('button', { name: 'More buttons' }).click();
    const panel = page.locator('.wm-overflow');
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Formatting Marks' }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('word.formattingMarks'))).toBe('on');
  });

  test('the layout follows the window: resizing from phone to desktop and back', async ({ app, page }) => {
    await page.setViewportSize(PHONE);
    await app.goto('?doc=welcome');
    await expect(hamburger(page)).toBeVisible();
    await resize(page, DESKTOP.width, DESKTOP.height);
    await expect(hamburger(page)).toBeHidden();
    await expect(menuTitle(app, 'View')).toBeVisible();
    await expect(page.getByRole('toolbar')).toHaveCount(2);
    await resize(page, PHONE.width, PHONE.height);
    await expect(hamburger(page)).toBeVisible();
    await expect(menuTitle(app, 'View')).toBeHidden();
    await expect(page.getByRole('toolbar')).toHaveCount(1);
  });

  test('the canvas is as wide as the phone window', async ({ app, page }) => {
    await page.setViewportSize(PHONE);
    await app.goto('?doc=welcome');
    expect((await app.canvas.boundingBox())!.width).toBeCloseTo(PHONE.width, 0);
  });

  test('document text can still be typed and read on a phone-sized window', async ({ app, page }) => {
    await page.setViewportSize(PHONE);
    await app.goto('?doc=welcome');
    await page.getByRole('toolbar').getByRole('button', { name: 'Undo' }).waitFor();
    await hamburger(page).click();
    await drawer(page).getByRole('menuitem', { name: /^New/ }).click();
    await expect(drawer(page)).toHaveCount(0);
    await app.focus();
    await page.keyboard.type('on a phone');
    expect(await app.text()).toBe('on a phone');
  });
});

test.describe('phone menu drawer', () => {
  test('the hamburger opens a drawer of grouped commands under small headings', async ({ app, page }) => {
    await page.setViewportSize(PHONE);
    await app.goto('?doc=welcome');
    await hamburger(page).click();
    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page).locator('.wm-drawer-title')).toHaveText('Menu');
    const headings = await drawer(page).locator('.wm-drawer-heading').allTextContents();
    expect(headings.map((h) => h.toLowerCase())).toEqual(['file', 'edit', 'insert', 'view', 'tools', 'help']);
    await expect(drawer(page).getByRole('menuitem', { name: /^New/ })).toBeVisible();
    await expect(drawer(page).getByRole('menuitem', { name: /^Find/ })).toBeVisible();
    await expect(drawer(page).getByRole('button', { name: 'Back' })).toBeHidden();
  });

  test('a command row runs its command and closes the drawer, returning the keyboard to the document', async ({ app, page }) => {
    await page.setViewportSize(PHONE);
    await app.goto('?doc=welcome');
    await hamburger(page).click();
    await drawer(page).getByRole('menuitem', { name: /^Word Count/ }).click();
    await expect(drawer(page)).toHaveCount(0);
    await expect(page.getByRole('dialog').first()).toBeVisible(); // the Word Count dialog
  });

  test('checkable rows show their state and toggle', async ({ app, page }) => {
    await page.setViewportSize(PHONE);
    await app.goto('?doc=welcome');
    await hamburger(page).click();
    const marks = drawer(page).getByRole('menuitemcheckbox', { name: /^Formatting Marks/ });
    await expect(marks).toHaveAttribute('aria-checked', 'false');
    await marks.click();
    await hamburger(page).click();
    await expect(drawer(page).getByRole('menuitemcheckbox', { name: /^Formatting Marks/ })).toHaveAttribute('aria-checked', 'true');
  });

  test('rows with submenus drill in, and Back (or Escape) returns one level', async ({ app, page }) => {
    await page.setViewportSize(PHONE);
    await app.goto('?doc=welcome');
    await hamburger(page).click();
    await drawer(page).getByRole('menuitem', { name: /^Convert To/ }).click();
    await expect(drawer(page).locator('.wm-drawer-title')).toHaveText('Convert To');
    await expect(drawer(page).getByRole('menuitem', { name: /PDF/ })).toBeVisible();
    await drawer(page).getByRole('button', { name: 'Back' }).click();
    await expect(drawer(page).locator('.wm-drawer-title')).toHaveText('Menu');
    await drawer(page).getByRole('menuitem', { name: /^Convert To/ }).click();
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page).locator('.wm-drawer-title')).toHaveText('Menu');
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
  });

  test('"All menus" reaches the full desktop menus', async ({ app, page }) => {
    await page.setViewportSize(PHONE);
    await app.goto('?doc=welcome');
    await hamburger(page).click();
    await drawer(page).getByRole('menuitem', { name: /^All menus/ }).scrollIntoViewIfNeeded();
    await drawer(page).getByRole('menuitem', { name: /^All menus/ }).click();
    await expect(drawer(page).locator('.wm-drawer-title')).toHaveText('All menus');
    await drawer(page).getByRole('menuitem', { name: /^View/ }).click();
    await expect(drawer(page).locator('.wm-drawer-title')).toHaveText('View');
    await expect(drawer(page).getByRole('menuitem', { name: /^Zoom/ })).toBeVisible();
    await drawer(page).getByRole('menuitem', { name: /^Zoom/ }).click();
    await drawer(page).getByRole('menuitemcheckbox', { name: /^200%/ }).click();
    await expect(drawer(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { camera: { zoom: number } }).camera.zoom)).toBeCloseTo(2, 2);
  });

  test('the close button, the backdrop and resizing the window all close it', async ({ app, page }) => {
    await page.setViewportSize(PHONE);
    await app.goto('?doc=welcome');
    await hamburger(page).click();
    await drawer(page).getByRole('button', { name: 'Close' }).click();
    await expect(drawer(page)).toHaveCount(0);
    await expect(app.editor).toBeFocused();

    await hamburger(page).click();
    await page.mouse.click(PHONE.width - 10, 300); // the dimmed backdrop beside the drawer
    await expect(drawer(page)).toHaveCount(0);

    await hamburger(page).click();
    await expect(drawer(page)).toBeVisible();
    await resize(page, 400, 700);
    await expect(drawer(page)).toHaveCount(0);
  });

  test('Open Recent lists what there is, or (none)', async ({ app, page }) => {
    await page.setViewportSize(PHONE);
    await app.goto('?doc=welcome');
    await hamburger(page).click();
    await drawer(page).getByRole('menuitem', { name: /^Open Recent/ }).click();
    await expect(drawer(page).locator('.wm-drawer-title')).toHaveText('Open Recent');
    await expect(drawer(page).getByRole('menuitem')).not.toHaveCount(0);
  });
});
