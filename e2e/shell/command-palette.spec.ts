import type { Page } from '@playwright/test';
import { expect, MOD, test, type App } from '../fixtures';
import { choose, isMac, menuTitle, stored } from './helpers';

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' });
const search = (page: Page) => palette(page).getByRole('textbox', { name: 'Search commands' });
const options = (page: Page) => palette(page).getByRole('option');
const option = (page: Page, label: string) => options(page).filter({ has: page.locator('.wm-palette-label', { hasText: new RegExp(`^${label}$`) }) });
const button = (page: Page) => page.getByRole('button', { name: 'Command palette' });

async function openPalette(app: App): Promise<void> {
  await button(app.page).click();
  await expect(palette(app.page)).toBeVisible();
  await expect(search(app.page)).toBeFocused();
}

test.describe('command palette', () => {
  test('the button opens it with the search box focused and every available command listed', async ({ app, page }) => {
    await app.blank();
    await expect(button(page)).toHaveAttribute('aria-expanded', 'false');
    await openPalette(app);
    await expect(button(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(palette(page).getByText('All commands')).toBeVisible();
    expect(await options(page).count()).toBeGreaterThan(100);
    await expect(option(page, 'Zoom In')).toHaveCount(1);
    // Each row shows its shortcut, or else its category.
    await expect(option(page, 'Zoom In').locator('.wm-palette-meta')).toHaveText((await isMac(page)) ? '⌘=' : 'Ctrl+=');
    await expect(option(page, 'Word Count').locator('.wm-palette-meta')).toHaveText('Tools');
  });

  test('the button has a tooltip naming its shortcut', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    const tip = await button(page).evaluate((el) => el.getAttribute('title') ?? el.getAttribute('data-tip'));
    expect(tip).toBe((await isMac(page)) ? 'Command palette (⇧⌘P)' : 'Command palette (Ctrl+Shift+P)');
  });

  test('typing narrows the list to commands matching every word, best matches first', async ({ app, page }) => {
    await app.blank();
    await openPalette(app);
    await search(page).fill('zoom');
    const labels = await options(page).locator('.wm-palette-label').allTextContents();
    expect(labels).toEqual(expect.arrayContaining(['Zoom In', 'Zoom Out']));
    expect(labels.every((l) => /zoom/i.test(l))).toBe(true);
    await search(page).fill('view actual');
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText('Actual Size');
    await search(page).fill('toolbar formatting');
    await expect(option(page, 'Toolbar: Formatting')).toHaveCount(1);
  });

  test('a search with no match says so', async ({ app, page }) => {
    await app.blank();
    await openPalette(app);
    await search(page).fill('qqqqzzzz');
    await expect(options(page)).toHaveCount(0);
    await expect(palette(page).getByText('No matching commands')).toBeVisible();
  });

  test('the first match is highlighted, arrows move the highlight and wrap, Enter runs it', async ({ app, page }) => {
    await app.blank();
    await openPalette(app);
    await search(page).fill('zoom');
    await expect(options(page).first()).toHaveClass(/active/);
    await search(page).press('ArrowDown');
    await expect(options(page).nth(1)).toHaveClass(/active/);
    await search(page).press('ArrowUp');
    await search(page).press('ArrowUp'); // wraps to the last
    await expect(options(page).last()).toHaveClass(/active/);
    await search(page).press('ArrowDown');
    await expect(options(page).first()).toHaveClass(/active/);

    await search(page).fill('actual size');
    await page.keyboard.press('Enter');
    await expect(palette(page)).toHaveCount(0);
    await expect(app.editor).toBeFocused();
    await expect.poll(() => page.evaluate(() => (window as unknown as { camera: { zoom: number } }).camera.zoom)).toBeCloseTo(1, 2);
  });

  test('clicking a command runs it', async ({ app, page }) => {
    await app.blank();
    await app.type('palette click');
    await openPalette(app);
    await search(page).fill('select all');
    await options(page).first().click();
    await expect(palette(page)).toHaveCount(0);
    await expect.poll(() => app.selectedText()).toBe('palette click');
  });

  test('hovering a row highlights it', async ({ app, page }) => {
    await app.blank();
    await openPalette(app);
    await search(page).fill('zoom');
    await options(page).nth(1).hover();
    await expect(options(page).nth(1)).toHaveClass(/active/);
    await expect(options(page).first()).not.toHaveClass(/active/);
  });

  test('disabled commands are listed as disabled and cannot be run', async ({ app, page }) => {
    await app.blank();
    await openPalette(app);
    await search(page).fill('undo');
    const undo = options(page).first();
    await expect(undo).toHaveAttribute('aria-disabled', 'true');
    await search(page).press('Enter');
    await undo.click({ force: true });
    await expect(palette(page)).toBeVisible(); // nothing ran, nothing closed
  });

  test('commands become enabled when they apply', async ({ app, page }) => {
    await app.blank();
    await app.type('x');
    await openPalette(app);
    await search(page).fill('undo');
    await expect(options(page).first()).toHaveAttribute('aria-disabled', 'false');
  });

  test('Escape closes it and the document keeps the keyboard', async ({ app, page }) => {
    await app.blank();
    await openPalette(app);
    await search(page).fill('bold');
    await page.keyboard.press('Escape');
    await expect(palette(page)).toHaveCount(0);
    await expect(app.editor).toBeFocused();
    await page.keyboard.type('ok');
    expect(await app.text()).toBe('ok');
  });

  test('the button toggles it, and clicking outside closes it', async ({ app, page }) => {
    await app.blank();
    await openPalette(app);
    await button(page).click();
    await expect(palette(page)).toHaveCount(0);
    await openPalette(app);
    await page.mouse.click(300, 600);
    await expect(palette(page)).toHaveCount(0);
  });

  test('recently run commands are listed first next time', async ({ app, page }) => {
    await app.blank();
    await openPalette(app);
    await search(page).fill('whole page');
    await page.keyboard.press('Enter');
    await expect.poll(async () => JSON.parse((await stored(page, 'golemdocs.recentCommands')) ?? '[]')[0]).toBe('view.wholePage');
    await openPalette(app);
    await expect(palette(page).getByText('Recent')).toBeVisible();
    await expect(options(page).first()).toContainText('Whole Page');
    await expect(palette(page).getByText('All commands')).toBeVisible();
  });

  test('commands not offered for the open format are left out', async ({ app, page }) => {
    await app.blank();
    await openPalette(app);
    await expect(option(page, 'Table: Merge Cells')).toHaveAttribute('aria-disabled', 'true'); // offered for documents, but only in a table
    // Picture tools exist only for picture documents.
    await search(page).fill('sepia');
    await expect(options(page)).toHaveCount(0);
  });

  test('it is reachable from the Tools menu', async ({ app, page }) => {
    await app.blank();
    await expect(menuTitle(app, 'Tools')).toBeVisible();
    await choose(app, 'Tools', 'Command palette');
    await expect(palette(page)).toBeVisible();
  });

  // Suspected bug: commands run from the keyboard or a menu end by returning the keyboard to the
  // document (CommandRegistry.execute), which steals it straight back from the palette that command
  // just opened, so typed text lands in the document while the palette sits open.
  test.fixme('Ctrl/Cmd+Shift+P opens it with the search box focused', async ({ app, page }) => {
    await app.blank();
    await page.keyboard.press(`${MOD}+Shift+P`);
    await expect(palette(page)).toBeVisible();
    await expect(search(page)).toBeFocused();
    await page.keyboard.type('zoom');
    await expect(search(page)).toHaveValue('zoom');
    expect(await app.text()).toBe('');
  });

  test.fixme('Tools ▸ Command palette opens it with the search box focused', async ({ app, page }) => {
    await app.blank();
    await choose(app, 'Tools', 'Command palette');
    await expect(search(page)).toBeFocused();
  });
});
