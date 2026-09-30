import type { Locator, Page } from '@playwright/test';
import { expect, test, type App } from '../fixtures';
import { choose, stored } from './helpers';

const dialog = (page: Page) => page.locator('dialog.wm-customize');
const onToolbar = (page: Page) => dialog(page).getByRole('listbox', { name: 'Toolbar buttons' }).getByRole('option');
const toolbarSelect = (page: Page) => dialog(page).getByRole('combobox', { name: 'Toolbar', exact: true });
const closeButton = (page: Page) => dialog(page).locator('.wm-dialog-buttons').getByRole('button', { name: 'Close' });
const commands = (page: Page) => dialog(page).getByRole('listbox', { name: 'Commands' });
const standard = (page: Page) => page.getByRole('toolbar', { name: 'Standard' });
const buttonNames = (bar: Locator) => bar.getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));

async function open(app: App): Promise<void> {
  await choose(app, 'View', 'Toolbars', 'Customize…');
  await expect(dialog(app.page)).toBeVisible();
}

async function select(page: Page, toolbar: string): Promise<void> {
  await toolbarSelect(page).selectOption({ label: toolbar });
}

test.describe('Customize Toolbars', () => {
  test('opens from View ▸ Toolbars and from Tools, and Close returns the keyboard to the document', async ({ app, page }) => {
    await app.blank();
    await open(app);
    await expect(closeButton(page)).toBeFocused();
    await closeButton(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(app.editor).toBeFocused();
    await choose(app, 'Tools', 'Customize…');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('lists the toolbars and shows the buttons on the selected one', async ({ app, page }) => {
    await app.blank();
    await open(app);
    const toolbars = await toolbarSelect(page).locator('option').allTextContents();
    expect(toolbars).toEqual(['Standard', 'Formatting', 'Picture', 'Draw']);
    await expect(onToolbar(page).first()).toContainText('New');
    await select(page, 'Formatting');
    await expect(onToolbar(page).first()).toContainText('Font');
    await expect(dialog(page).getByRole('checkbox', { name: /Show this toolbar/ })).toBeChecked();
  });

  test('removing a button takes it off the toolbar at once, and Reset Toolbar puts it back', async ({ app, page }) => {
    await app.blank();
    await expect(app.toolbarButton('Open')).toBeVisible();
    await open(app);
    await onToolbar(page).filter({ hasText: /^See all your documents$/ }).click();
    await dialog(page).getByRole('button', { name: '‹ Remove' }).click();
    await expect(app.toolbarButton('Open')).toHaveCount(0);
    await expect(onToolbar(page).filter({ hasText: /^See all your documents$/ })).toHaveCount(0);
    await dialog(page).getByRole('button', { name: 'Reset Toolbar' }).click();
    await expect(app.toolbarButton('Open')).toBeVisible();
    await expect(onToolbar(page).filter({ hasText: /^See all your documents$/ })).toHaveCount(1);
  });

  test('adding a command puts a button on the toolbar; commands already there cannot be added twice', async ({ app, page }) => {
    await app.blank();
    await expect(app.toolbarButton('Find')).toHaveCount(0);
    await open(app);
    const add = dialog(page).getByRole('button', { name: 'Add ›' });
    await expect(add).toBeDisabled();
    await commands(page).getByRole('option', { name: /^Find/ }).first().click();
    await expect(add).toBeEnabled();
    await add.click();
    await expect(app.toolbarButton('Find')).toBeVisible();
    // It is now on the toolbar: the catalog row is marked used and Add is disabled for it.
    await expect(add).toBeDisabled();
    await expect(commands(page).getByRole('option', { name: /^Find/ }).first()).toHaveClass(/used/);
    expect((await buttonNames(standard(page))).filter((n) => n === 'Find')).toHaveLength(1);
  });

  test('double-clicking adds from the catalog and removes from the toolbar list', async ({ app, page }) => {
    await app.blank();
    await open(app);
    await commands(page).getByRole('option', { name: /^Replace/ }).first().dblclick();
    await expect(app.toolbarButton('Replace')).toBeVisible();
    await onToolbar(page).filter({ hasText: /^Replace/ }).dblclick();
    await expect(app.toolbarButton('Replace')).toHaveCount(0);
  });

  test('the category box narrows the command list', async ({ app, page }) => {
    await app.blank();
    await open(app);
    const all = await commands(page).getByRole('option').count();
    await dialog(page).getByRole('combobox', { name: 'Category', exact: true }).selectOption({ label: 'Table' });
    const table = await commands(page).getByRole('option').count();
    expect(table).toBeGreaterThan(0);
    expect(table).toBeLessThan(all);
    await expect(commands(page).getByRole('option', { name: /Merge Cells/ })).toHaveCount(1);
    await expect(commands(page).getByRole('option', { name: /^Bold/ })).toHaveCount(0);
  });

  test('Move Up and Move Down reorder the buttons on the toolbar', async ({ app, page }) => {
    await app.blank();
    await open(app);
    const before = await buttonNames(standard(page));
    expect(before.slice(0, 2)).toEqual(['New', 'Open']);
    await onToolbar(page).filter({ hasText: /^See all your documents$/ }).click();
    await dialog(page).getByRole('button', { name: 'Move Up' }).click();
    await expect.poll(async () => (await buttonNames(standard(page))).slice(0, 2)).toEqual(['Open', 'New']);
    await expect(dialog(page).getByRole('button', { name: 'Move Up' })).toBeDisabled(); // at the top
    await dialog(page).getByRole('button', { name: 'Move Down' }).click();
    await expect.poll(async () => (await buttonNames(standard(page))).slice(0, 2)).toEqual(['New', 'Open']);
  });

  test('a separator can be added after the selected button', async ({ app, page }) => {
    await app.blank();
    await open(app);
    const count = await onToolbar(page).count();
    await onToolbar(page).first().click();
    await dialog(page).getByRole('button', { name: 'Separator' }).click();
    await expect(onToolbar(page)).toHaveCount(count + 1);
    await expect(onToolbar(page).nth(1)).toHaveText('Separator');
  });

  test('keyboard: arrows select in the toolbar list, Alt+Arrow moves and Delete removes', async ({ app, page }) => {
    await app.blank();
    await open(app);
    await onToolbar(page).first().click(); // New
    const list = dialog(page).getByRole('listbox', { name: 'Toolbar buttons' });
    await list.press('ArrowDown'); // Open
    await list.press('Alt+ArrowUp');
    await expect.poll(async () => (await buttonNames(standard(page))).slice(0, 2)).toEqual(['Open', 'New']);
    await list.press('Delete');
    await expect(app.toolbarButton('Open')).toHaveCount(0);
  });

  test('dragging a row within the list reorders it', async ({ app, page }) => {
    await app.blank();
    await open(app);
    await onToolbar(page).filter({ hasText: /^See all your documents$/ }).dragTo(onToolbar(page).filter({ hasText: /^New Blank Document$/ }), { targetPosition: { x: 20, y: 2 } });
    await expect.poll(async () => (await buttonNames(standard(page))).slice(0, 2)).toEqual(['Open', 'New']);
  });

  test('dragging a command from the catalog onto the toolbar list adds it', async ({ app, page }) => {
    await app.blank();
    await open(app);
    await commands(page).getByRole('option', { name: /^Go To/ }).first().dragTo(onToolbar(page).first(), { targetPosition: { x: 20, y: 2 } });
    await expect(app.toolbarButton('Go To')).toBeVisible();
  });

  test('unticking "Show this toolbar" hides the toolbar and ticking shows it again', async ({ app, page }) => {
    await app.blank();
    await open(app);
    await select(page, 'Formatting');
    const show = dialog(page).getByRole('checkbox', { name: /Show this toolbar/ });
    await show.uncheck();
    await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeHidden();
    await show.check();
    await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
  });

  test('changes are saved in this browser and survive a reload; a fresh profile has the defaults', async ({ app, page }) => {
    await app.blank();
    await open(app);
    await onToolbar(page).filter({ hasText: /^See all your documents$/ }).click();
    await dialog(page).getByRole('button', { name: '‹ Remove' }).click();
    await commands(page).getByRole('option', { name: /^Find/ }).first().dblclick();
    await closeButton(page).click();
    const saved = JSON.parse((await stored(page, 'word.toolbars.v1')) ?? 'null') as { name: string; items: string[] }[];
    const items = saved.find((bar) => bar.name === 'Standard')!.items;
    expect(items).not.toContain('file.open');
    expect(items).toContain('edit.find');
    await page.reload();
    await app.ready();
    await expect(app.toolbarButton('Open')).toHaveCount(0);
    await expect(app.toolbarButton('Find')).toBeVisible();
  });

  test('the layout applies to the other toolbar controls too: Zoom and Font boxes can be removed', async ({ app, page }) => {
    await app.blank();
    await expect(page.getByRole('toolbar', { name: 'Standard' }).getByRole('combobox', { name: 'Zoom' })).toBeVisible();
    await open(app);
    await onToolbar(page).filter({ hasText: /^Zoom Box$/ }).click();
    await dialog(page).getByRole('button', { name: '‹ Remove' }).click();
    await expect(page.getByRole('toolbar', { name: 'Standard' }).getByRole('combobox', { name: 'Zoom' })).toHaveCount(0);
  });
});
