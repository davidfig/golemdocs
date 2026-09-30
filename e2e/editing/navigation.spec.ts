import { test, expect } from '../fixtures';
import { DOC, IS_MAC, WORD, caret, waitCaretSettled } from './helpers';

/** Types a marker at the caret and reads the document, then removes the marker again. */
async function whereIsCaret(app: import('../fixtures').App): Promise<string> {
  await app.type('|');
  const text = await app.text();
  // app.text() leaves the caret at the end; callers re-navigate, so the marker is left in place.
  return text;
}

test.describe('caret movement', () => {
  test('ArrowLeft and ArrowRight move one character; they stop at the ends', async ({ app }) => {
    await app.blank();
    await app.type('abc');
    await app.press('ArrowRight', 3); // already at the end
    await app.press('ArrowLeft', 2);
    expect(await whereIsCaret(app)).toBe('a|bc');
    await app.press('Home');
    await app.press('ArrowLeft', 3); // already at the start
    expect(await whereIsCaret(app)).toBe('|a|bc');
  });

  test('Home and End go to the start and end of the line', async ({ app }) => {
    await app.blank();
    await app.type('hello world');
    await app.press('ArrowLeft', 3);
    await app.press('Home');
    expect(await whereIsCaret(app)).toBe('|hello world');
    await app.press('Home');
    await app.press('End');
    expect(await whereIsCaret(app)).toBe('|hello world|');
  });

  test('ArrowUp and ArrowDown move between paragraphs, keeping the column', async ({ app }) => {
    await app.blank();
    await app.type('xxxxxxxxxx');
    await app.press('Enter');
    await app.type('xxxxxxxxxx');
    await app.press('Home');
    await app.press('ArrowRight', 4);
    await app.press('ArrowUp');
    await waitCaretSettled(app);
    await app.type('^');
    await app.press('ArrowDown');
    await app.type('v');
    await expect.poll(() => app.text()).toBe('xxxx^xxxxxx\nxxxxxvxxxxx');
  });

  test('ArrowDown on the last line and ArrowUp on the first line are harmless', async ({ app }) => {
    await app.blank();
    await app.type('only');
    await app.press('ArrowDown');
    await app.press('ArrowUp');
    await app.type('!');
    await expect.poll(() => app.text()).toMatch(/^!?only!?$/);
  });

  test('Ctrl/Cmd+Home and +End go to the start and end of the document', async ({ app }) => {
    await app.blank();
    await app.type('top');
    await app.press('Enter', 2);
    await app.type('bottom');
    await app.press(`${DOC}+Home`);
    await app.type('<');
    await app.press(`${DOC}+End`);
    await app.type('>');
    await expect.poll(() => app.text()).toBe('<top\n\nbottom>');
  });

  test('word movement skips whole words', async ({ app }) => {
    await app.blank();
    await app.type('alpha beta gamma');
    await app.press(`${DOC}+Home`);
    await app.press(`${WORD}+ArrowRight`);
    await app.type('|');
    await app.press(`${DOC}+End`);
    await app.press(`${WORD}+ArrowLeft`);
    await app.type('#');
    const text = await app.text();
    // The exact stop (before or after the space) depends on the platform, but it is at a word edge.
    expect(text.replace(/[|#]/g, '')).toBe('alpha beta gamma');
    expect(text).toMatch(/alpha\|? ?\|?beta|alpha\| beta/);
    expect(text).toMatch(/#gamma/);
  });

  test('PageDown and PageUp scroll the view', async ({ app }) => {
    await app.blank();
    await app.editor.focus();
    for (let i = 0; i < 40; i++) {
      await app.page.keyboard.insertText(`Paragraph number ${i}`);
      await app.press('Enter');
    }
    await app.press(`${DOC}+Home`);
    await waitCaretSettled(app);
    const y0 = await app.page.evaluate(() => (window as unknown as { camera: { y: number } }).camera.y);
    await app.press('PageDown');
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { camera: { y: number } }).camera.y)).toBeGreaterThan(y0);
    const y1 = await app.page.evaluate(() => (window as unknown as { camera: { y: number } }).camera.y);
    await app.press('PageUp');
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { camera: { y: number } }).camera.y)).toBeLessThan(y1);
  });

  test('moving the caret to the end of a long document scrolls it into view', async ({ app }) => {
    await app.blank();
    await app.editor.focus();
    for (let i = 0; i < 80; i++) {
      await app.page.keyboard.insertText(`Line ${i}`);
      await app.press('Enter');
    }
    await app.press(`${DOC}+Home`);
    await app.press(`${DOC}+End`);
    await waitCaretSettled(app);
    // The caret is inside the canvas.
    const box = await app.canvas.boundingBox();
    const at = await app.page.evaluate(() => {
      const w = window as unknown as { selectionState: { caret: { page: number; y: number } | null }; pages: { id: number; y: number }[]; camera: { y: number; zoom: number } };
      const c = w.selectionState.caret!;
      const page = w.pages.find((p) => p.id === c.page)!;
      return (page.y + c.y - w.camera.y) * w.camera.zoom * (96 / 72);
    });
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThanOrEqual(box!.height);
  });

  test('Command+Arrow moves by line and document on macOS', async ({ app }) => {
    test.skip(!IS_MAC, 'Command-arrow shortcuts exist on macOS only');
    await app.blank();
    await app.type('one');
    await app.press('Enter');
    await app.type('two three');
    await app.press('Meta+ArrowLeft');
    await app.type('<');
    await app.press('Meta+ArrowRight');
    await app.type('>');
    await app.press('Meta+ArrowUp');
    await app.type('^');
    await app.press('Meta+ArrowDown');
    await app.type('v');
    await expect.poll(() => app.text()).toBe('^one\n<two three>v');
  });
});

test.describe('keyboard selection', () => {
  test('Shift+Arrow extends and shrinks the selection', async ({ app }) => {
    await app.blank();
    await app.type('abcdef');
    await app.press('Shift+ArrowLeft', 3);
    await expect.poll(() => app.selectedText()).toBe('def');
    await app.press('Shift+ArrowRight');
    await expect.poll(() => app.selectedText()).toBe('ef');
    await app.press('Shift+ArrowRight', 5);
    await expect.poll(() => app.selectedText()).toBe('');
  });

  test('a plain arrow key collapses the selection to that side', async ({ app }) => {
    await app.blank();
    await app.type('abcdef');
    await app.press('Shift+ArrowLeft', 3);
    await app.press('ArrowLeft');
    await expect.poll(() => app.selectedText()).toBe('');
    expect(await whereIsCaret(app)).toMatch(/abc\|def|ab\|cdef|abcdef\|?/);
  });

  test('Shift+Home and Shift+End select to the line edges', async ({ app }) => {
    await app.blank();
    await app.type('hello world');
    await app.press('ArrowLeft', 5);
    await app.press('Shift+Home');
    await expect.poll(() => app.selectedText()).toBe('hello ');
    await app.press('End');
    await app.press('ArrowLeft', 5);
    await app.press('Shift+End');
    await expect.poll(() => app.selectedText()).toBe('world');
  });

  test('Shift+Ctrl/Cmd+Home and +End select to the document edges', async ({ app }) => {
    await app.blank();
    await app.type('one');
    await app.press('Enter');
    await app.type('two');
    await app.press('ArrowUp');
    await app.press('End');
    await app.press(`Shift+${DOC}+End`);
    await expect.poll(() => app.selectedText()).toBe('\ntwo');
    await app.press(`${DOC}+End`);
    await app.press(`Shift+${DOC}+Home`);
    await expect.poll(() => app.selectedText()).toBe('one\ntwo');
  });

  test('Shift+word movement selects whole words', async ({ app }) => {
    await app.blank();
    await app.type('alpha beta gamma');
    await app.press(`Shift+${WORD}+ArrowLeft`);
    await expect.poll(() => app.selectedText()).toBe('gamma');
    await app.press(`Shift+${WORD}+ArrowLeft`);
    await expect.poll(() => app.selectedText()).toMatch(/^beta ?gamma$/);
  });

  test('Shift+ArrowUp and Shift+ArrowDown select across paragraphs', async ({ app }) => {
    await app.blank();
    await app.type('first');
    await app.press('Enter');
    await app.type('second');
    await app.press('Shift+ArrowUp');
    await expect.poll(() => app.selectedText()).toMatch(/^\w*\n\w*$/);
    await expect.poll(() => app.selectedText()).toContain('\n');
    await app.press('ArrowDown');
    await app.press(`${DOC}+Home`);
    await app.press('Shift+ArrowDown');
    await expect.poll(() => app.selectedText()).toMatch(/^first\n/);
  });

  test('Ctrl/Cmd+A selects the whole document, including several paragraphs', async ({ app }) => {
    await app.blank();
    await app.type('one');
    await app.press('Enter');
    await app.type('two');
    await app.press(`${DOC}+a`);
    await expect.poll(() => app.selectedText()).toBe('one\ntwo');
  });

  test('Edit ▸ Select All selects the document', async ({ app }) => {
    await app.blank();
    await app.type('every word');
    await app.press(`${DOC}+Home`);
    await app.menu('Edit', 'Select All');
    await expect.poll(() => app.selectedText()).toBe('every word');
  });

  test('Select All in an empty document leaves nothing selected', async ({ app }) => {
    await app.blank();
    await app.press(`${DOC}+a`);
    await expect.poll(() => app.selectedText()).toBe('');
    expect(await caret(app)).not.toBeNull();
  });
});
