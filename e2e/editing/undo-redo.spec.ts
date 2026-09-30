import { test, expect, type App } from '../fixtures';
import { IS_MAC, MOD, tool } from './helpers';

/** Types, then waits until the editor has the text (an undo sent any sooner races the typing). */
async function typeAndWait(app: App, text: string, expected = text): Promise<void> {
  await app.type(text);
  await expect.poll(() => app.text()).toBe(expected);
}

test.describe('undo and redo', () => {
  test('both buttons start disabled in a new document, Undo enables after typing', async ({ app }) => {
    await app.blank();
    await expect(tool(app, 'Undo')).toBeDisabled();
    await expect(tool(app, 'Redo')).toBeDisabled();
    await app.type('x');
    await expect(tool(app, 'Undo')).toBeEnabled();
    await expect(tool(app, 'Redo')).toBeDisabled();
  });

  test('Ctrl/Cmd+Z undoes a run of typing as one step and Redo brings it back', async ({ app }) => {
    await app.blank();
    await typeAndWait(app, 'Hello world');
    await app.press(`${MOD}+z`);
    await expect.poll(() => app.text()).toBe('');
    await expect(tool(app, 'Undo')).toBeDisabled();
    await expect(tool(app, 'Redo')).toBeEnabled();
    await app.press(`${MOD}+Shift+z`);
    await expect.poll(() => app.text()).toBe('Hello world');
    await expect(tool(app, 'Redo')).toBeDisabled();
  });

  test('Enter and each typing run are separate undo steps', async ({ app }) => {
    await app.blank();
    await typeAndWait(app, 'one');
    await app.press('Enter');
    await typeAndWait(app, 'two', 'one\ntwo');
    await app.press(`${MOD}+z`);
    await expect.poll(() => app.text()).toBe('one\n');
    await app.press(`${MOD}+z`);
    await expect.poll(() => app.text()).toBe('one');
    await app.press(`${MOD}+z`);
    await expect.poll(() => app.text()).toBe('');
  });

  test('the toolbar Undo and Redo buttons work', async ({ app }) => {
    await app.blank();
    await app.type('abc');
    await tool(app, 'Undo').click();
    await expect.poll(() => app.text()).toBe('');
    await tool(app, 'Redo').click();
    await expect.poll(() => app.text()).toBe('abc');
  });

  test('Edit ▸ Undo and Edit ▸ Redo work and show their state', async ({ app }) => {
    await app.blank();
    await app.type('abc');
    await app.menu('Edit', 'Undo');
    await expect.poll(() => app.text()).toBe('');
    await app.menu('Edit', 'Redo');
    await expect.poll(() => app.text()).toBe('abc');
    // With nothing left to redo the menu item is disabled.
    await app.menubar.getByRole('menuitem', { name: /^Edit$/ }).click();
    await expect(app.page.getByRole('menu').getByRole('menuitem', { name: /^Redo/ })).toHaveAttribute('aria-disabled', 'true');
    await app.press('Escape');
  });

  test('a new edit after an undo discards what could have been redone', async ({ app }) => {
    await app.blank();
    await typeAndWait(app, 'first');
    await app.press(`${MOD}+z`);
    await expect.poll(() => app.text()).toBe('');
    await app.type('second');
    await expect(tool(app, 'Redo')).toBeDisabled();
    await expect.poll(() => app.text()).toBe('second');
  });

  test('the platform redo shortcut works (Ctrl+Y on Windows and Linux)', async ({ app }) => {
    test.skip(IS_MAC, 'Ctrl+Y is redo on Windows and Linux only');
    await app.blank();
    await typeAndWait(app, 'abc');
    await app.press(`${MOD}+z`);
    await expect.poll(() => app.text()).toBe('');
    await app.press('Control+y');
    await expect.poll(() => app.text()).toBe('abc');
  });

  test('formatting changes undo separately from the text', async ({ app }) => {
    await app.blank();
    await app.type('bold me');
    await app.press(`${MOD}+a`);
    await app.press(`${MOD}+b`);
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'true');
    await app.press(`${MOD}+z`);
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => app.text()).toBe('bold me');
  });

  test('typing over a selection can be undone back to the original text, and redone', async ({ app }) => {
    await app.blank();
    await typeAndWait(app, 'keep this');
    await app.press(`${MOD}+a`);
    await app.type('new');
    await expect.poll(() => app.text()).toBe('new');
    // However the replacement is split into steps, a few undos restore the original...
    let undos = 0;
    let now = 'new';
    while (now !== 'keep this' && undos < 3) {
      const before = now;
      await app.press(`${MOD}+z`);
      undos++;
      await expect.poll(() => app.text()).not.toBe(before);
      now = await app.text();
    }
    expect(now).toBe('keep this');
    // ...and as many redos bring the new text back.
    for (let i = 0; i < undos; i++) await app.press(`${MOD}+Shift+z`);
    await expect.poll(() => app.text()).toBe('new');
  });

  test('many undos past the start stay at the empty document', async ({ app }) => {
    await app.blank();
    await typeAndWait(app, 'a');
    await app.press(`${MOD}+z`, 5);
    await expect.poll(() => app.text()).toBe('');
    await app.press(`${MOD}+Shift+z`, 5);
    await expect.poll(() => app.text()).toBe('a');
  });
});
