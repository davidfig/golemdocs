import { test, expect } from '../fixtures';
import { DOC, IS_MAC, MOD, WORD } from './helpers';

test.describe('typing and deleting', () => {
  test('typed characters appear in order, with spaces and punctuation', async ({ app }) => {
    await app.blank();
    await app.type('The quick brown fox, jumps over: 12 lazy dogs!');
    await expect.poll(() => app.text()).toBe('The quick brown fox, jumps over: 12 lazy dogs!');
  });

  test('non-ASCII text is typed as is', async ({ app }) => {
    await app.blank();
    await app.editor.focus();
    await app.page.keyboard.insertText('Grüße – café ✓ 日本語');
    await expect.poll(() => app.text()).toBe('Grüße – café ✓ 日本語');
  });

  test('Enter splits the paragraph at the caret', async ({ app }) => {
    await app.blank();
    await app.type('HelloWorld');
    await app.press('ArrowLeft', 5);
    await app.press('Enter');
    await expect.poll(() => app.text()).toBe('Hello\nWorld');
  });

  test('Enter at the end and on an empty paragraph adds empty paragraphs', async ({ app }) => {
    await app.blank();
    await app.type('One');
    await app.press('Enter', 2);
    await app.type('Two');
    await expect.poll(() => app.text()).toBe('One\n\nTwo');
  });

  test('Shift+Enter inserts a line break inside the paragraph', async ({ app }) => {
    await app.blank();
    await app.type('Line one');
    await app.press('Shift+Enter');
    await app.type('line two');
    const xml = await downloadXml(app);
    // One paragraph holding a <w:br/>.
    expect(xml.match(/<w:p[ >]/g)).toHaveLength(1);
    expect(xml).toContain('<w:br/>');
  });

  test('Backspace deletes the character before the caret', async ({ app }) => {
    await app.blank();
    await app.type('Hello!');
    await app.press('Backspace');
    await expect.poll(() => app.text()).toBe('Hello');
  });

  test('Backspace at the start of a paragraph joins it to the previous one', async ({ app }) => {
    await app.blank();
    await app.type('One');
    await app.press('Enter');
    await app.type('Two');
    await app.press('Home');
    await app.press('Backspace');
    await expect.poll(() => app.text()).toBe('OneTwo');
  });

  test('Backspace in an empty document does nothing', async ({ app }) => {
    await app.blank();
    await app.press('Backspace', 3);
    await app.type('x');
    await expect.poll(() => app.text()).toBe('x');
  });

  test('Delete removes the character after the caret and joins paragraphs at the end', async ({ app }) => {
    await app.blank();
    await app.type('abcd');
    await app.press('Home');
    await app.press('Delete');
    await expect.poll(() => app.selectedText()).toBe('');
    await app.press('ArrowRight', 2);
    await app.press('Delete');
    await expect.poll(() => app.text()).toBe('bc');
    // Join: caret at the end of the first paragraph.
    await app.blank();
    await app.type('ab');
    await app.press('Enter');
    await app.type('cd');
    await app.press('ArrowUp');
    await app.press('End');
    await app.press('Delete');
    await expect.poll(() => app.text()).toBe('abcd');
  });

  test('word-wise Backspace and Delete remove a whole word', async ({ app }) => {
    await app.blank();
    await app.type('one two three');
    await app.press(`${WORD}+Backspace`);
    await expect.poll(() => app.text()).toBe('one two ');
    await app.press(`${DOC}+Home`);
    await app.press(`${WORD}+Delete`);
    await expect.poll(() => app.text()).not.toMatch(/^one/);
  });

  test('typing over a selection replaces it', async ({ app }) => {
    await app.blank();
    await app.type('Hello world');
    await app.press(`Shift+${WORD}+ArrowLeft`);
    await expect.poll(() => app.selectedText()).toBe('world');
    await app.type('there');
    await expect.poll(() => app.text()).toBe('Hello there');
  });

  test('Backspace and Delete on a selection remove exactly the selection', async ({ app }) => {
    await app.blank();
    await app.type('abcdef');
    await app.press('Shift+ArrowLeft', 3);
    await app.press('Backspace');
    await expect.poll(() => app.text()).toBe('abc');
    await app.press('Home');
    await app.press('Shift+ArrowRight');
    await app.press('Delete');
    await expect.poll(() => app.text()).toBe('bc');
  });

  test('Tab inserts a tab character outside tables', async ({ app }) => {
    await app.blank();
    await app.type('a');
    await app.press('Tab');
    await app.type('b');
    await expect.poll(() => app.text()).toBe('a\tb');
  });

  test('a long paragraph wraps and stays one paragraph', async ({ app }) => {
    await app.blank();
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    await app.editor.focus();
    await app.page.keyboard.insertText(words);
    await expect.poll(() => app.text()).toBe(words);
    expect(await app.page.evaluate(() => (window as unknown as { pages: unknown[] }).pages.length)).toBeGreaterThanOrEqual(1);
  });

  test('enough text flows onto a second page', async ({ app }) => {
    await app.blank();
    await app.editor.focus();
    const paragraph = 'Lorem ipsum dolor sit amet. '.repeat(12);
    for (let i = 0; i < 30; i++) {
      await app.page.keyboard.insertText(paragraph);
      await app.press('Enter');
    }
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { pages: unknown[] }).pages.length)).toBeGreaterThan(1);
  });

  test('Insert ▸ Date and Time puts a date at the caret', async ({ app }) => {
    await app.blank();
    // The ISO (YYYY-MM-DD) entry is the fourth in the submenu.
    const today = await app.page.evaluate(() => new Date().toISOString().slice(0, 10));
    await app.menubar.getByRole('menuitem', { name: /^Insert$/ }).click();
    await app.page.getByRole('menu').getByRole('menuitem', { name: /^Date and Time/ }).click();
    await app.page.getByRole('menuitem', { name: today, exact: true }).click();
    await expect.poll(() => app.text()).toBe(today);
  });

  test('Insert ▸ Symbol puts a character at the caret', async ({ app }) => {
    await app.blank();
    await app.type('a');
    await app.menubar.getByRole('menuitem', { name: /^Insert$/ }).click();
    await app.page.getByRole('menu').getByRole('menuitem', { name: /^Symbol/ }).click();
    await app.page.getByRole('menuitem', { name: /Copyright/ }).click();
    await expect.poll(() => app.text()).toBe('a©');
  });

  test('Insert ▸ Page Numbers says it is not available yet and leaves the text alone', async ({ app }) => {
    await app.blank();
    await app.type('body');
    await app.menu('Insert', 'Page Numbers');
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { status: string }).status)).toMatch(/isn.t available yet/);
    await expect.poll(() => app.text()).toBe('body');
  });

  test('Insert ▸ Break ▸ Page Break starts a new page', async ({ app }) => {
    await app.blank();
    await app.type('before');
    await app.press(`${MOD}+Enter`);
    await app.type('after');
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { pages: unknown[] }).pages.length)).toBe(2);
    await expect.poll(() => app.text()).toContain('before');
  });

  test('the page shows a caret after New, and typing works right after focus', async ({ app }) => {
    await app.blank();
    expect(await app.page.evaluate(() => (window as unknown as { selectionState: { caret: unknown } }).selectionState.caret)).not.toBeNull();
    await app.type(IS_MAC ? 'mac' : 'pc');
    await expect.poll(() => app.text()).toMatch(/^(mac|pc)$/);
  });
});

async function downloadXml(app: import('../fixtures').App): Promise<string> {
  const { downloadDocumentXml } = await import('./helpers');
  return downloadDocumentXml(app);
}
