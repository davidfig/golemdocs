// Clicking the check box of a Markdown task item checks or unchecks it and leaves the caret where it was,
// also while the item shows its Markdown (Show Markdown at the Caret).

import { expect, test } from '../fixtures';
import { importFile, text } from '../files/helpers';
import { caret, caretClient, clickAt, lineGaps, waitCaretSettled } from './helpers';
import type { App } from '../fixtures';

test.use({ livePreviewDefault: true });

/** Two task items with the caret at the end of the second (its Markdown shown). */
async function twoItems(app: App): Promise<void> {
  await app.blank();
  await importFile(app, text('tasks.md', '- [ ] one\n- [ ] two\n'));
  await app.focus();
  await app.press('ControlOrMeta+ArrowDown');
  await app.press('End');
  await waitCaretSettled(app);
}

/** The window point of the first item's drawn check box, found by hovering for the pointer cursor. */
async function boxOfFirstItem(app: App, lineY: number, textX: number): Promise<{ x: number; y: number }> {
  for (let x = textX - 40; x < textX + 40; x += 2) {
    await app.page.mouse.move(x, lineY);
    await app.page.waitForTimeout(40);
    if ((await app.page.evaluate(() => document.getElementById('canvas')!.style.cursor)) === 'pointer') return { x: x + 2, y: lineY };
  }
  throw new Error('no check box found');
}

test.describe('Task list check boxes', () => {
  test('clicking a check box toggles it without moving the caret', async ({ app }) => {
    await twoItems(app);
    const end = await caret(app);
    await app.press('ArrowUp');
    await waitCaretSettled(app);
    const upClient = await caretClient(app);
    await app.press('ArrowDown');
    await app.press('End');
    await waitCaretSettled(app);
    const box = await boxOfFirstItem(app, upClient.y, upClient.x);
    await clickAt(app, box);
    await waitCaretSettled(app);
    expect((await caret(app))!.y).toBe(end!.y);
    await app.type('!');
    const file = await app.download(() => app.menu('File', 'Download'));
    expect(file.text.trim()).toBe('- [x] one\n- [ ] two!');
  });

  test('the [ ] of the item the caret is in toggles too, and the caret stays', async ({ app }) => {
    await twoItems(app);
    const gaps = await lineGaps(app, '- [ ] two'.length);
    const middle = { x: (gaps[2].x + gaps[3].x) / 2, y: gaps[2].y };
    await clickAt(app, middle);
    await waitCaretSettled(app);
    await app.page.waitForTimeout(700); // not a double click
    await clickAt(app, middle);
    await waitCaretSettled(app);
    let file = await app.download(() => app.menu('File', 'Download'));
    expect(file.text.trim()).toBe('- [ ] one\n- [ ] two');
    await app.page.waitForTimeout(700);
    await clickAt(app, middle);
    await waitCaretSettled(app);
    await app.type('!');
    file = await app.download(() => app.menu('File', 'Download'));
    expect(file.text.trim()).toBe('- [ ] one\n- [x] two!');
  });
});
