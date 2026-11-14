// Closing a dialog gives the keyboard back to where it was (docs/architecture/accessibility.md): a screen reader user
// who presses Escape lands in the document again, not on an empty page.

import { MOD, expect, test, type App } from '../fixtures';

const focused = (app: App) => app.page.evaluate(() => {
  const el = document.activeElement;
  return el === document.body || !el ? 'body' : el.id || el.className;
});

/** Dialogs from the menus: [menu, item]. */
const FROM_MENUS: [string, string][] = [
  ['File', 'Page Setup'],
  ['File', 'Properties'],
  ['Edit', 'Go To'],
  ['Edit', 'Find'],
  ['Edit', 'Paste Special'],
  ['Format', 'Paragraph'],
  ['Format', 'Columns'],
  ['Tools', 'Spelling'],
  ['Tools', 'Word Count'],
  ['Tools', 'Options'],
];

test.describe('Dialogs give the focus back', () => {
  for (const [menu, item] of FROM_MENUS) {
    test(`${menu} › ${item}, opened from the menu and closed with Escape`, async ({ app }) => {
      await app.blank();
      await app.type('Some text');
      await app.menu(menu, item);
      await expect(app.page.locator('dialog[open]')).toHaveCount(1);
      await app.press('Escape');
      await expect(app.page.locator('dialog[open]')).toHaveCount(0);
      await expect.poll(() => focused(app)).toBe('input');
    });
  }

  test('a dialog opened from the keyboard through the menu bar gives the focus back to the document', async ({ app }) => {
    await app.blank();
    await app.type('Some text');
    await app.press('F10');
    await app.press('ArrowRight', 5); // File, Edit, View, Insert, Format, Tools
    await expect(app.page.getByRole('menuitem', { name: /^Tools$/ })).toBeFocused();
    await app.press('ArrowDown');
    await app.press('Enter'); // its first item opens Spelling
    await expect(app.page.locator('dialog[open]')).toHaveCount(1);
    await app.press('Escape');
    await expect(app.page.locator('dialog[open]')).toHaveCount(0);
    await expect.poll(() => focused(app)).toBe('input');
  });

  for (const [menu, item] of FROM_MENUS) {
    test(`${menu} › ${item}, closed with the mouse`, async ({ app }) => {
      await app.blank();
      await app.type('Some text');
      await app.menu(menu, item);
      const dialog = app.page.locator('dialog[open]');
      await expect(dialog).toHaveCount(1);
      // The last of the dialog's buttons (OK, Close, Cancel…), or else the title bar's close button.
      await dialog.locator('.wm-dialog-buttons button').last().or(dialog.getByRole('button', { name: 'Close' })).first().click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => focused(app)).toBe('input');
    });
  }

  test('when what opened a dialog is gone, closing it gives the focus to the document', async ({ app }) => {
    await app.blank();
    await app.type('Some text');
    // Stand-ins for a dialog that does nothing about the focus itself, and an opener that goes away while it is open
    // (a menu row, a card).
    await app.page.evaluate(() => {
      const button = document.body.appendChild(document.createElement('button'));
      button.focus();
      const dialog = document.body.appendChild(document.createElement('dialog'));
      dialog.append(document.createElement('button'));
      dialog.showModal();
      button.remove();
    });
    await app.press('Escape');
    await expect(app.page.locator('dialog[open]')).toHaveCount(0);
    await expect.poll(() => focused(app)).toBe('input');
  });

  test('a dialog opened by its shortcut gives the focus back', async ({ app }) => {
    await app.blank();
    await app.type('Some text');
    await app.press(`${MOD}+g`);
    await expect(app.page.locator('dialog[open]')).toHaveCount(1);
    await app.press('Escape');
    await expect.poll(() => focused(app)).toBe('input');
  });
});
