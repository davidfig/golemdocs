// The dialogs and panels that came with the Format and Insert dialogs, the Thesaurus, the command palette and the notes at
// the bottom of the window, from the keyboard and to a screen reader (docs/architecture/accessibility.md, "Getting around the
// window from the keyboard"): their roles and names, where the keyboard goes, and what is said.

import type { Locator, Page } from '@playwright/test';
import { MOD, expect, test, type App } from '../fixtures';
import { DOC } from '../editing/helpers';

const dialog = (app: App, name: string) => app.page.getByRole('dialog', { name, exact: true });
const focusedId = (app: App) => app.page.evaluate(() => document.activeElement?.id ?? '');
/** What was last said through the polite live region (ui/announce.ts). */
const said = (page: Page) => page.locator('.wm-sr-only[aria-live="polite"]');

/** A document holding `text`, with the caret at its start. */
async function withText(app: App, text: string): Promise<void> {
  await app.blank();
  await app.editor.focus();
  await app.page.keyboard.insertText(text);
  await expect.poll(() => app.text()).toBe(text);
  await app.press(`${DOC}+Home`);
}

test.describe('Format dialogs', () => {
  test('Bullets and Numbering: named by its title, tabs and galleries move with the arrow keys, Escape gives the keyboard back', async ({ app }) => {
    await withText(app, 'item');
    await app.menu('Format', 'Bullets and Numbering');
    const box = dialog(app, 'Bullets and Numbering');
    await expect(box).toBeVisible();
    // Named by the title bar it shows.
    const title = await box.getAttribute('aria-labelledby');
    expect(title).toBeTruthy();
    await expect(box.locator(`[id="${title}"]`)).toHaveText('Bullets and Numbering');

    const tabs = box.getByRole('tablist');
    const bulleted = tabs.getByRole('tab', { name: 'Bulleted' });
    await expect(bulleted).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
    await expect(box.getByRole('tabpanel', { name: 'Bulleted' })).toBeVisible();

    // The gallery is a radio group with one Tab stop: the keyboard starts on the chosen tile, and every arrow chooses.
    const gallery = box.getByRole('radiogroup', { name: 'Bulleted' });
    const tiles = gallery.getByRole('radio');
    await expect(tiles.first()).toBeFocused();
    await expect(gallery.locator('[tabindex="0"]')).toHaveCount(1);
    await app.press('ArrowRight');
    await expect(tiles.nth(1)).toBeFocused();
    await expect(tiles.nth(1)).toHaveAttribute('aria-checked', 'true');
    await expect(tiles.first()).toHaveAttribute('aria-checked', 'false');
    await app.press('ArrowDown');
    await expect(tiles.nth(2)).toHaveAttribute('aria-checked', 'true');
    await app.press('End');
    await expect(tiles.last()).toBeFocused();
    await expect(tiles.last()).toHaveAttribute('aria-checked', 'true');
    await expect(gallery.locator('[tabindex="0"]')).toHaveCount(1);

    // Back to the tabs, and Right shows the next one.
    await app.press('Shift+Tab');
    await expect(bulleted).toBeFocused();
    await app.press('ArrowRight');
    const numbered = tabs.getByRole('tab', { name: 'Numbered' });
    await expect(numbered).toBeFocused();
    await expect(numbered).toHaveAttribute('aria-selected', 'true');
    await expect(box.getByRole('tabpanel', { name: 'Numbered' })).toBeVisible();
    await expect(box.getByRole('tabpanel', { name: 'Bulleted' })).toBeHidden();

    await app.press('Escape');
    await expect(box).toBeHidden();
    await expect.poll(() => focusedId(app)).toBe('input');
  });

  test('Font: a drop-down list says its choice, opens from the keyboard and gives the keyboard back; a color says its name', async ({ app }) => {
    await withText(app, 'some words');
    await app.press(`${MOD}+a`);
    await app.menu('Format', 'Font');
    const box = dialog(app, 'Font');
    const style = box.getByRole('button', { name: 'Style', exact: true });
    await expect(style).toHaveAccessibleDescription('Regular');
    await style.focus();
    await app.press('ArrowDown');
    const list = app.page.getByRole('listbox', { name: 'Style' });
    await expect(list.getByRole('option', { name: 'Regular', exact: true })).toBeFocused();
    await expect(list.getByRole('option', { name: 'Regular', exact: true })).toHaveAttribute('aria-selected', 'true');
    await app.press('ArrowDown');
    await expect(list.getByRole('option', { name: 'Italic', exact: true })).toBeFocused();
    await app.press('Enter');
    await expect(list).toBeHidden();
    await expect(style).toBeFocused();
    await expect(style).toHaveAccessibleDescription('Italic');

    const color = box.getByRole('button', { name: 'Color', exact: true });
    await expect(color).toHaveAccessibleDescription('Automatic');
    await color.click();
    await app.page.locator('.wm-swatch[title="#FF0000"]').click();
    await expect(color).toHaveAccessibleDescription('Red');
    await box.getByRole('button', { name: 'Cancel' }).click();
  });

  test('Styles: the list is a list box in groups, read as it moves, with the style described', async ({ app }) => {
    await withText(app, 'words');
    await app.menu('Format', 'Styles');
    const box = dialog(app, 'Styles');
    const list = box.getByRole('listbox', { name: 'Styles' });
    await expect(list).toBeFocused();
    await expect(list.getByRole('group', { name: 'Paragraph' }).getByRole('option').first()).toBeVisible();
    const before = await list.getAttribute('aria-activedescendant');
    await expect(list.locator(`[id="${before}"]`)).toHaveAttribute('aria-selected', 'true');
    await expect(list).toHaveAccessibleDescription(/\d+ pt/);
    await app.press('ArrowDown');
    await expect.poll(() => list.getAttribute('aria-activedescendant')).not.toBe(before);
    const after = await list.getAttribute('aria-activedescendant');
    await expect(list.locator(`[id="${after}"]`)).toHaveAttribute('aria-selected', 'true');
    await expect(list.locator('[aria-selected="true"]')).toHaveCount(1);
    await app.press('Escape');
    await expect(box).toBeHidden();
    await expect.poll(() => focusedId(app)).toBe('input');
  });
});

test.describe('The document’s right-click menu from the keyboard', () => {
  test('Shift+F10 opens the word’s menu with the keyboard in it; Right opens the synonyms, Enter picks one', async ({ app }) => {
    await withText(app, 'The quick fox');
    await app.press('ArrowRight', 6); // inside "quick"
    await app.press('Shift+F10');
    const synonyms = app.page.getByRole('menuitem', { name: 'Synonyms', exact: true });
    await expect(synonyms).toBeFocused();
    await expect(synonyms).toHaveAttribute('aria-haspopup', 'menu');
    await app.press('ArrowDown');
    await expect(app.page.getByRole('menuitem', { name: /^Thesaurus/ })).toBeFocused();
    await app.press('ArrowUp');
    await app.press('ArrowRight');
    await expect(synonyms).toHaveAttribute('aria-expanded', 'true');
    // The synonyms come from the layout worker; the keyboard goes to the first when they arrive.
    const picked = app.page.locator('.wm-popup-menu').nth(1).getByRole('menuitem').first();
    await expect(picked).toBeFocused();
    // Left goes back to the row, Right in again.
    await app.press('ArrowLeft');
    await expect(synonyms).toBeFocused();
    await app.press('ArrowRight');
    await expect(picked).toBeFocused();
    const word = (await picked.textContent())!.trim();
    await app.press('Enter');
    await expect(app.page.getByRole('menu')).toHaveCount(0);
    await expect.poll(() => app.text()).toBe(`The ${word} fox`);
    await expect.poll(() => focusedId(app)).toBe('input');
  });

  test('Escape closes it and gives the keyboard back to the document', async ({ app }) => {
    await withText(app, 'The quick fox');
    await app.press('ArrowRight', 6);
    await app.press('Shift+F10');
    await expect(app.page.getByRole('menuitem', { name: 'Synonyms', exact: true })).toBeFocused();
    await app.press('Escape');
    await expect(app.page.getByRole('menu')).toHaveCount(0);
    await expect.poll(() => focusedId(app)).toBe('input');
  });

  test('on a misspelled word it is the spelling menu, said with what is wrong, and a suggestion is picked with Enter', async ({ app }) => {
    await withText(app, 'I recieve mail.');
    await app.press('ArrowRight', 4); // inside "recieve"
    await app.press('Shift+F10');
    const menu = app.page.getByRole('menu', { name: 'Spelling' });
    await expect(menu.getByRole('menuitem', { name: 'receive', exact: true })).toBeFocused();
    await expect(menu).toHaveAccessibleDescription(/\S/);
    await app.press('Enter');
    await expect(menu).toBeHidden();
    await expect.poll(() => app.text()).toBe('I receive mail.');
  });
});

test.describe('Thesaurus', () => {
  test('what a lookup found is said, since the focus stays in the box', async ({ app }) => {
    await withText(app, 'happy');
    await app.press('Shift+F7');
    await expect(dialog(app, 'Thesaurus')).toBeVisible();
    await expect(said(app.page)).toHaveText(/^happy: \d+ meanings?$/);
  });
});

test.describe('Command palette', () => {
  test('its search box is a combo box over a list box, and how many rows a search found is said', async ({ app }) => {
    await app.blank();
    await app.press(`${MOD}+Shift+P`);
    const combo = app.page.getByRole('combobox', { name: 'Search commands and documents' });
    await expect(combo).toBeFocused();
    await expect(combo).toHaveAttribute('aria-expanded', 'true');
    const list = app.page.locator(`[id="${await combo.getAttribute('aria-controls')}"]`);
    await expect(list).toHaveAttribute('role', 'listbox');
    await expect(list.getByRole('group', { name: 'All commands' })).toBeVisible();
    const first = await combo.getAttribute('aria-activedescendant');
    await expect(list.locator(`[id="${first}"]`)).toHaveAttribute('aria-selected', 'true');
    await app.press('ArrowDown');
    await expect.poll(() => combo.getAttribute('aria-activedescendant')).not.toBe(first);
    await expect(list.locator('[aria-selected="true"]')).toHaveCount(1);

    await app.page.keyboard.type('bold');
    await expect(said(app.page)).toHaveText(/^\d+ results?$/);
    await app.page.keyboard.type('zzzz');
    await expect(said(app.page)).toHaveText('No matching commands or documents');
    await app.press('Escape');
    await expect.poll(() => focusedId(app)).toBe('input');
  });
});

test.describe('Lists and keys in the settings dialogs', () => {
  test('Customize Toolbars: the picked command is the list’s active, selected option', async ({ app }) => {
    await app.blank();
    await app.menu('Tools', 'Customize');
    const box = dialog(app, 'Customize Toolbars');
    const commands = box.getByRole('listbox', { name: 'Commands' });
    await commands.focus();
    await app.press('ArrowDown');
    const id = await commands.getAttribute('aria-activedescendant');
    expect(id).toBeTruthy();
    await expect(box.locator(`[id="${id}"]`)).toHaveAttribute('aria-selected', 'true');
    await app.press('ArrowDown');
    await expect.poll(() => commands.getAttribute('aria-activedescendant')).not.toBe(id);
    await expect(commands.locator('[aria-selected="true"]')).toHaveCount(1);
  });

  test('Keyboard Shortcuts: each key button says the key it has now', async ({ app }) => {
    await app.blank();
    await app.press('F1');
    await expect(app.page.getByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeVisible();
    await expect(app.page.getByRole('button', { name: /^Change shortcut for Bold: \S/ })).toBeVisible();
  });
});

test.describe('Notes at the bottom of the window', () => {
  test('a new version’s note is said when it comes, F6 reaches it, and closing it gives the keyboard back', async ({ app, page }) => {
    await page.addInitScript(() => localStorage.setItem('golem.newVersion.seen', '0.0.1'));
    await app.goto('?doc=welcome');
    const notice = page.getByRole('complementary', { name: 'New version' });
    await expect(notice).toBeVisible();
    await expect(said(page)).toContainText('has been released');
    await app.focus();
    // F6 goes through the parts of the window; the note is one of them while it shows.
    const inNotice = () => page.evaluate(() => !!document.activeElement?.closest('.wm-notice'));
    for (let i = 0; i < 12 && !(await inNotice()); i++) await app.press('F6');
    expect(await inNotice()).toBe(true);
    await expect(notice.getByRole('button', { name: 'Close' })).toBeFocused();
    await app.press('Enter');
    await expect(notice).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.activeElement !== document.body && !!document.activeElement)).toBe(true);
  });
});

test.describe('High Contrast and Windows contrast themes', () => {
  async function galleryTiles(app: App): Promise<{ chosen: Locator; other: Locator }> {
    await withText(app, 'item');
    await app.menu('Format', 'Bullets and Numbering');
    const gallery = dialog(app, 'Bullets and Numbering').getByRole('radiogroup', { name: 'Bulleted' });
    await gallery.getByRole('radio').nth(1).click();
    return { chosen: gallery.locator('[aria-checked="true"]'), other: gallery.locator('[aria-checked="false"]').first() };
  }
  const look = (tile: Locator) => tile.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopColor, shadow: s.boxShadow, background: s.backgroundColor, outline: s.outlineStyle };
  });

  test('the chosen tile stays visible in High Contrast’s dark form, whose title colour is black', async ({ app, page }) => {
    const { chosen, other } = await galleryTiles(app);
    await page.evaluate(() => Object.assign(document.documentElement.dataset, { theme: 'dark', scheme: 'contrast' }));
    const on = await look(chosen);
    const off = await look(other);
    expect(on.border).toBe('rgb(255, 255, 0)');
    expect(on.shadow).not.toBe(off.shadow);
    expect(on.background).not.toBe(off.background);
  });

  test('the chosen tile has an edge in a Windows contrast theme', async ({ app, page }) => {
    const { chosen, other } = await galleryTiles(app);
    await page.emulateMedia({ forcedColors: 'active' });
    expect((await look(chosen)).outline).toBe('solid');
    expect((await look(other)).outline).not.toBe('solid');
  });
});
