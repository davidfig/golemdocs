// Typing Markdown shortcuts ("# ", "- [ ] ", "**bold**", "---") makes real formatting, and Backspace takes it back.

import { expect, test } from '../fixtures';
import { convertTo, importFile, text } from '../files/helpers';
import { caretClient, waitCaretSettled } from './helpers';

test.describe('Markdown shortcuts as you type', () => {
  test('headings, check boxes, marks and rules are made as they are typed', async ({ app }) => {
    await app.blank();
    await convertTo(app, 'Markdown (.md)', 'Markdown');
    await app.focus();
    await app.type('# Title');
    await app.press('Enter');
    await app.type('- [ ] todo');
    await app.press('Enter');
    await app.type('more');
    await app.press('Enter', 2);
    await app.type('Some **bold** and *it* and `code` and [a link](https://example.com/) end');
    await app.press('Enter');
    await app.type('---');
    await app.press('Enter');
    await app.type('After');
    const file = await app.download(() => app.menu('File', 'Download'));
    expect(file.text.trim()).toBe('# Title\n\n- [ ] todo\n- [ ] more\n\nSome **bold** and *it* and `code` and [a link](https://example.com/) end\n\n---\n\nAfter');
  });

  test('Backspace right after a conversion gives back what was typed', async ({ app }) => {
    await app.blank();
    await app.type('**bold**');
    await app.press('Backspace');
    await expect.poll(() => app.text()).toBe('**bold**');
    await app.type(' x');
    await expect.poll(() => app.text()).toBe('**bold** x');
  });

  test('what is typed after a converted mark is not marked', async ({ app }) => {
    await app.blank();
    await convertTo(app, 'Markdown (.md)', 'Markdown');
    await app.focus();
    await app.type('**bold** plain');
    const file = await app.download(() => app.menu('File', 'Download'));
    expect(file.text.trim()).toBe('**bold** plain');
  });

  test('Tools › Autoformat as You Type turns the shortcuts off', async ({ app }) => {
    await app.blank();
    await app.menu('Tools', 'Autoformat as You Type');
    await app.focus();
    await app.type('**bold** and - ');
    await expect.poll(() => app.text()).toBe('**bold** and - ');
    await app.menu('Tools', 'Autoformat as You Type');
  });

  test('clicking a check box checks or unchecks it', async ({ app }) => {
    await app.goto('?doc=welcome');
    await importFile(app, text('tasks.md', '- [ ] todo\n- [x] done\n'));
    await app.focus();
    await app.press('ControlOrMeta+Home');
    // The box is left of the item's text, in the hanging indent.
    await waitCaretSettled(app);
    const at = await caretClient(app);
    await app.page.mouse.move(at.x - 18, at.y);
    await expect.poll(() => app.canvas.evaluate((el) => (el as HTMLElement).style.cursor)).toBe('pointer');
    await app.page.mouse.click(at.x - 18, at.y);
    await app.press('ArrowDown');
    await waitCaretSettled(app);
    const second = await caretClient(app);
    await app.page.mouse.click(second.x - 18, second.y);
    const file = await app.download(() => app.menu('File', 'Download'));
    expect(file.text.trim()).toBe('- [x] todo\n- [ ] done');
  });

  test('Insert › Checklist and the toolbar button start a check box list, and turn it off again', async ({ app }) => {
    await app.blank();
    await convertTo(app, 'Markdown (.md)', 'Markdown');
    await app.focus();
    await app.type('one');
    await app.menu('Insert', 'Checklist');
    await app.press('Enter');
    await app.type('two');
    const on = await app.download(() => app.menu('File', 'Download'));
    expect(on.text.trim()).toBe('- [ ] one\n- [ ] two');
    await app.page.getByRole('button', { name: 'Checklist' }).first().click();
    const off = await app.download(() => app.menu('File', 'Download'));
    expect(off.text.trim()).toBe('- [ ] one\n\ntwo');
  });
});
