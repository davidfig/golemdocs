// Tools › Show Markdown at the Caret: the paragraph the caret is in shows its Markdown, the others are formatted.

import { expect, test, type App } from '../fixtures';
import { importFile, text } from '../files/helpers';
import { IS_MAC, caretClient, clickAt } from './helpers';

/** The text of the line the caret is in, as shown: the caret goes to the line's end and the line is selected backwards (selecting within a line leaves its Markdown showing). */
async function line(app: App): Promise<string> {
  await app.press('End');
  await app.press('Shift+Home');
  await app.settle();
  return app.selectedText();
}

test.describe('Show Markdown at the caret', () => {
  test('the paragraph with the caret shows its Markdown as the caret moves', async ({ app }) => {
    await app.goto('?doc=welcome');
    await importFile(app, text('live.md', '# Title\n\nsome **bold**\n'));
    await app.focus();
    await app.menu('Tools', 'Show Markdown at the Caret');
    await app.press('ControlOrMeta+Home');
    expect(await line(app)).toBe('# Title');
    await app.press('ArrowDown');
    expect(await line(app)).toBe('some **bold**');
    await app.press('ArrowUp');
    expect(await line(app)).toBe('# Title');
    await expect.poll(() => app.text()).toBe('Title\nsome bold');
    await app.menu('Tools', 'Show Markdown at the Caret');
  });

  test('editing the Markdown changes the formatting once the caret leaves', async ({ app }) => {
    await app.goto('?doc=welcome');
    await importFile(app, text('live.md', 'first\n\nsecond\n'));
    await app.focus();
    await app.menu('Tools', 'Show Markdown at the Caret');
    await app.press('ControlOrMeta+End');
    await app.type(' **now bold**');
    expect(await line(app)).toBe('second **now bold**');
    await app.press('ArrowUp');
    expect(await line(app)).toBe('first');
    const file = await app.download(() => app.menu('File', 'Download'));
    expect(file.text.trim()).toBe('first\n\nsecond **now bold**');
    await app.menu('Tools', 'Show Markdown at the Caret');
  });

  test('Ctrl/Cmd+click follows a link in a paragraph the caret is not in, and in one the caret enters', async ({ app }) => {
    await app.goto('?doc=welcome');
    await importFile(app, text('live.md', 'See [[Missing Note]] now.\n\nsecond\n'));
    await app.focus();
    await app.menu('Tools', 'Show Markdown at the Caret');
    await app.press('ControlOrMeta+Home');
    await app.settle();
    const start = await caretClient(app);
    await app.press('ControlOrMeta+End');
    await app.settle();
    await expect.poll(() => app.text()).toBe('See Missing Note now.\nsecond');
    const ask = app.page.locator('dialog.wm-dialog', { hasText: 'Document not found' });
    // The link is "Missing Note", after "See ".
    await clickAt(app, { x: start.x + 70, y: start.y }, { modifiers: [IS_MAC ? 'Meta' : 'Control'] });
    await expect(ask).toContainText('“Missing Note”');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    // With the caret inside the link its Markdown shows, and the link still follows.
    await app.press('ControlOrMeta+Home');
    await app.press('ArrowRight', 8);
    await app.settle();
    await clickAt(app, { x: start.x + 50, y: start.y }, { modifiers: [IS_MAC ? 'Meta' : 'Control'] });
    await expect(ask).toContainText('“Missing Note”');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await app.menu('Tools', 'Show Markdown at the Caret');
  });
});
