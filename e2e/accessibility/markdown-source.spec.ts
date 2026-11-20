// View › Markdown Source by role and name, and by keyboard alone: the menu item is a checkbox that says whether the source
// shows, and ⌘/ (Ctrl+/) goes there and back with the focus in the text being edited.

import { expect, test } from '../fixtures';
import { convertTo } from '../files/helpers';

test.describe('Markdown source view, by keyboard and role', () => {
  test('a checkbox menu item, offered only for Markdown, checked while the source shows', async ({ app }) => {
    await app.blank();
    const list = () => app.page.evaluate(() => window.golem.commands.list('view.markdownSource'));
    expect((await list())[0]?.available).toBe(false);
    await convertTo(app, 'Markdown (.md)', 'Markdown');
    expect((await list())[0]?.available).toBe(true);
    await app.menu('View', 'Markdown Source');
    await expect.poll(() => app.inTextEditor()).toBe(true);
    await app.menubar.getByRole('menuitem', { name: /^View$/ }).click();
    await expect(app.page.getByRole('menu').getByRole('menuitemcheckbox', { name: /^Markdown Source/ })).toHaveAttribute('aria-checked', 'true');
    await app.page.keyboard.press('Escape');
  });

  test('the shortcut goes to the source and back, with the focus where typing goes', async ({ app }) => {
    await app.blank();
    await convertTo(app, 'Markdown (.md)', 'Markdown');
    await app.type('Hello');
    await app.idle();
    await app.press('ControlOrMeta+/');
    await expect.poll(() => app.inTextEditor()).toBe(true);
    await expect(app.page.locator('.wm-large-input')).toBeFocused();
    await app.press('ControlOrMeta+End');
    await app.page.keyboard.type(' there');
    await app.press('ControlOrMeta+/');
    await expect.poll(() => app.inTextEditor()).toBe(false);
    await expect(app.editor).toBeFocused();
    await app.idle();
    expect((await app.outline())?.map((n) => n.text)).toEqual(['Hello there']);
  });
});
