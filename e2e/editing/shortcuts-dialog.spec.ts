import { test, expect, type App } from '../fixtures';
import { IS_MAC, MOD, tool, typeAndSelect } from './helpers';

// This dialog has no accessible name (showDialog gives it none), so it is found by its content.
const shortcuts = (app: App) => app.page.locator('dialog[open]').filter({ hasText: 'Restore Defaults' });
const change = (app: App, label: string) => shortcuts(app).getByRole('button', { name: `Change shortcut for ${label}`, exact: true });
const cmd = IS_MAC ? '⌘' : 'Ctrl+';

async function open(app: App) {
  await app.press('F1');
  await expect(shortcuts(app)).toBeVisible();
}

test.describe('Keyboard Shortcuts dialog', () => {
  test('F1 and the toolbar button open it, listing the commands with their keys', async ({ app }) => {
    await app.blank();
    await tool(app, 'Keyboard Shortcuts').click();
    await expect(shortcuts(app)).toBeVisible();
    await app.page.keyboard.press('Escape');
    await expect(shortcuts(app)).toHaveCount(0);
    await open(app);
    await expect(change(app, 'Bold')).toHaveText(IS_MAC ? '⌘B' : 'Ctrl+B');
    await expect(change(app, 'Italic')).toHaveText(IS_MAC ? '⌘I' : 'Ctrl+I');
    await expect(change(app, 'Underline')).toHaveText(IS_MAC ? '⌘U' : 'Ctrl+U');
    await expect(change(app, 'Undo')).toHaveText(IS_MAC ? '⌘Z' : 'Ctrl+Z');
    await expect(change(app, 'Find')).toHaveText(IS_MAC ? '⌘F' : 'Ctrl+F');
    await expect(change(app, 'Spelling and Grammar')).toHaveText('F7');
    await expect(change(app, 'Hyperlink')).toHaveText(IS_MAC ? '⌘K' : 'Ctrl+K');
    await expect(change(app, 'Center')).toHaveText(IS_MAC ? '⌘E' : 'Ctrl+E');
  });

  test('clipboard keys are shown but fixed', async ({ app }) => {
    await app.blank();
    await open(app);
    for (const name of ['Cut', 'Copy', 'Paste']) await expect(change(app, name)).toBeDisabled();
    await expect(change(app, 'Bold')).toBeEnabled();
    void cmd;
  });

  test('shows the hint and a Restore Defaults button', async ({ app }) => {
    await app.blank();
    await open(app);
    await expect(shortcuts(app).getByText('Click a shortcut, then press the new keys. Backspace clears it, Esc cancels.')).toBeVisible();
    await expect(shortcuts(app).getByRole('button', { name: 'Restore Defaults' })).toBeVisible();
  });

  test('a command can be given new keys, which then work and the old ones stop', async ({ app }) => {
    await app.blank();
    await open(app);
    await change(app, 'Bold').click();
    await expect(change(app, 'Bold')).toHaveText('Press keys…');
    await app.page.keyboard.press(`${MOD}+Shift+k`);
    await expect(change(app, 'Bold')).toHaveText(IS_MAC ? '⇧⌘K' : 'Ctrl+Shift+K');
    await app.page.keyboard.press('Escape');
    await expect(shortcuts(app)).toHaveCount(0);
    await app.focus();
    await typeAndSelect(app, 'text');
    await app.press(`${MOD}+b`);
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'false');
    await app.press(`${MOD}+Shift+k`);
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a key already used moves to the new command, with a message', async ({ app }) => {
    await app.blank();
    await open(app);
    await change(app, 'Italic').click();
    await app.page.keyboard.press(`${MOD}+b`);
    await expect(shortcuts(app).getByRole('status')).toHaveText('Bold no longer has those keys.');
    await expect(change(app, 'Italic')).toHaveText(IS_MAC ? '⌘B' : 'Ctrl+B');
    await expect(change(app, 'Bold')).toHaveText('None');
  });

  test('a plain letter is refused; Backspace clears; Escape cancels', async ({ app }) => {
    await app.blank();
    await open(app);
    await change(app, 'Bold').click();
    await app.page.keyboard.press('x');
    await expect(shortcuts(app).getByRole('status')).toHaveText('Include Ctrl, Alt or ⌘ (or use a function key).');
    await app.page.keyboard.press('Escape');
    await expect(change(app, 'Bold')).toHaveText(IS_MAC ? '⌘B' : 'Ctrl+B');
    await change(app, 'Bold').click();
    await app.page.keyboard.press('Backspace');
    await expect(change(app, 'Bold')).toHaveText('None');
  });

  test('Restore Defaults puts the keys back', async ({ app }) => {
    await app.blank();
    await open(app);
    await change(app, 'Bold').click();
    await app.page.keyboard.press(`${MOD}+Shift+k`);
    await shortcuts(app).getByRole('button', { name: 'Restore Defaults' }).click();
    await expect(change(app, 'Bold')).toHaveText(IS_MAC ? '⌘B' : 'Ctrl+B');
  });

  test('changed keys are remembered after a reload', async ({ app }) => {
    await app.blank();
    await open(app);
    await change(app, 'Bold').click();
    await app.page.keyboard.press(`${MOD}+Shift+k`);
    await app.page.reload();
    await app.ready();
    await app.press('F1');
    await expect(change(app, 'Bold')).toHaveText(IS_MAC ? '⇧⌘K' : 'Ctrl+Shift+K');
  });
});
