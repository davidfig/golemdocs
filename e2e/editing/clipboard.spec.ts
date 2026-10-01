import { test, expect } from '../fixtures';
import { DOC, MOD, clipboardText, dialog, downloadDocumentXml, selectBy, setClipboard, tool, typeAndSelect } from './helpers';

test.describe('copy, cut and paste', () => {
  test('Copy puts the selected text on the clipboard and leaves the document alone', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'copy me');
    await app.press(`${MOD}+c`);
    await expect.poll(() => clipboardText(app.page)).toBe('copy me');
    await expect.poll(() => app.text()).toBe('copy me');
  });

  test('Cut removes the selection and puts it on the clipboard', async ({ app }) => {
    await app.blank();
    await app.type('keep cut');
    await selectBy(app, 'Shift+ArrowLeft', 3, 'cut');
    await app.press(`${MOD}+x`);
    await expect.poll(() => clipboardText(app.page)).toBe('cut');
    await expect.poll(() => app.text()).toBe('keep ');
  });

  test('Cut then Paste moves text', async ({ app }) => {
    await app.blank();
    await app.type('one two');
    await selectBy(app, 'Shift+ArrowLeft', 4, ' two');
    await app.press(`${MOD}+x`);
    await expect.poll(() => app.text()).toBe('one');
    await app.press(`${DOC}+Home`);
    await app.press(`${MOD}+v`);
    await expect.poll(() => app.text()).toBe(' twoone');
  });

  test('Copy then Paste duplicates text at the caret', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'abc');
    await app.press(`${MOD}+c`);
    await expect.poll(() => clipboardText(app.page)).toBe('abc');
    await app.press(`${DOC}+End`);
    await app.press(`${MOD}+v`);
    await app.press(`${MOD}+v`);
    await expect.poll(() => app.text()).toBe('abcabcabc');
  });

  test('Paste over a selection replaces it', async ({ app }) => {
    await app.blank();
    await app.type('hello world');
    await setClipboard(app.page, { text: 'there' });
    await selectBy(app, 'Shift+ArrowLeft', 5, 'world');
    await app.press(`${MOD}+v`);
    await expect.poll(() => app.text()).toBe('hello there');
  });

  test('pasting several lines makes several paragraphs', async ({ app }) => {
    await app.blank();
    await setClipboard(app.page, { text: 'line one\nline two\nline three' });
    await app.press(`${MOD}+v`);
    await expect.poll(() => app.text()).toBe('line one\nline two\nline three');
  });

  test('plain text from elsewhere is pasted without formatting', async ({ app }) => {
    await app.blank();
    await app.type('x');
    await app.press(`${MOD}+a`);
    await app.press(`${MOD}+b`);
    await setClipboard(app.page, { text: 'plain' });
    await app.press(`${DOC}+End`);
    await app.press(`${MOD}+v`);
    await expect.poll(() => app.text()).toBe('xplain');
  });

  test('pasting formatted HTML keeps its bold, italic and paragraphs', async ({ app }) => {
    await app.blank();
    await setClipboard(app.page, { text: 'Bold and italic\nSecond', html: '<p><b>Bold</b> and <i>italic</i></p><p>Second</p>' });
    await app.press(`${MOD}+v`);
    await expect.poll(() => app.text()).toBe('Bold and italic\nSecond');
    const xml = await downloadDocumentXml(app);
    expect(xml).toMatch(/<w:b\/>[\s\S]*<w:t[^>]*>Bold<\/w:t>/);
    expect(xml).toMatch(/<w:i\/>[\s\S]*<w:t[^>]*>italic<\/w:t>/);
    expect(xml.match(/<w:p[ >]/g)).toHaveLength(2);
  });

  test('pasting HTML with a link keeps the link', async ({ app }) => {
    await app.blank();
    await setClipboard(app.page, { text: 'site', html: '<a href="https://example.com/">site</a>' });
    await app.press(`${MOD}+v`);
    await expect.poll(() => app.text()).toBe('site');
    const xml = await downloadDocumentXml(app);
    expect(xml).toContain('w:hyperlink');
  });

  test('a paste is one undo step', async ({ app }) => {
    await app.blank();
    await app.type('ab');
    await expect.poll(() => app.text()).toBe('ab');
    await setClipboard(app.page, { text: 'line one\nline two' });
    await app.press(`${MOD}+v`);
    await expect.poll(() => app.text()).toBe('abline one\nline two');
    await app.press(`${MOD}+z`);
    await expect.poll(() => app.text()).toBe('ab');
  });

  test('Edit menu: Copy and Cut are disabled without a selection, enabled with one', async ({ app }) => {
    await app.blank();
    await app.type('text');
    await app.press('ArrowLeft');
    const enabled = async (name: string) => {
      await app.menubar.getByRole('menuitem', { name: /^Edit$/ }).click();
      const item = app.page.getByRole('menu').getByRole('menuitem', { name: new RegExp(`^${name}`) }).first();
      const value = await item.getAttribute('aria-disabled');
      await app.press('Escape');
      return value === 'false';
    };
    expect(await enabled('Copy')).toBe(false);
    expect(await enabled('Cut')).toBe(false);
    expect(await enabled('Paste')).toBe(true);
    await app.press('Shift+ArrowLeft');
    await expect.poll(() => app.selectedText()).toBe('x');
    await expect.poll(() => enabled('Copy')).toBe(true);
    expect(await enabled('Cut')).toBe(true);
  });

  test('toolbar Copy, Cut and Paste buttons follow the selection', async ({ app }) => {
    await app.blank();
    await expect(tool(app, 'Copy')).toBeDisabled();
    await expect(tool(app, 'Cut')).toBeDisabled();
    await expect(tool(app, 'Paste')).toBeEnabled();
    await app.type('button text');
    await app.press(`${MOD}+a`);
    await expect(tool(app, 'Copy')).toBeEnabled();
    await expect(tool(app, 'Cut')).toBeEnabled();
    await tool(app, 'Copy').click();
    await expect.poll(() => clipboardText(app.page)).toBe('button text');
    await tool(app, 'Cut').click();
    await expect.poll(() => app.text()).toBe('');
    await tool(app, 'Paste').click();
    await expect.poll(() => app.text()).toBe('button text');
  });

  test('Edit ▸ Copy, Cut and Paste work from the menu', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'menu text');
    await app.menu('Edit', 'Copy');
    await expect.poll(() => clipboardText(app.page)).toBe('menu text');
    await app.menu('Edit', 'Cut');
    await expect.poll(() => app.text()).toBe('');
    await app.menu('Edit', 'Paste');
    await expect.poll(() => app.text()).toBe('menu text');
  });

  test('the toolbar Paste button pastes formatted HTML too', async ({ app }) => {
    await app.blank();
    await setClipboard(app.page, { text: 'Strong', html: '<strong>Strong</strong>' });
    await tool(app, 'Paste').click();
    await expect.poll(() => app.text()).toBe('Strong');
    await app.press('Home');
    await app.press('Shift+End');
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('Paste Special', () => {
  const html = '<p><b>Rich</b> text</p>';

  test('shows the choices and a preview of the clipboard', async ({ app }) => {
    await app.blank();
    await setClipboard(app.page, { text: 'Rich text', html });
    await app.menu('Edit', 'Paste Special');
    const box = dialog(app.page, 'Paste Special');
    await expect(box).toBeVisible();
    await expect(box.getByRole('radio', { name: 'Formatted text (HTML)' })).toBeChecked();
    await expect(box.getByRole('radio', { name: 'Unformatted text' })).not.toBeChecked();
    await expect(box).toContainText('Rich text');
    await box.getByRole('button', { name: 'Cancel' }).click();
    await expect(box).toHaveCount(0);
  });

  test('Cancel pastes nothing', async ({ app }) => {
    await app.blank();
    await setClipboard(app.page, { text: 'Rich text', html });
    await app.menu('Edit', 'Paste Special');
    await dialog(app.page, 'Paste Special').getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => app.text()).toBe('');
  });

  test('OK with the HTML choice pastes the formatting', async ({ app }) => {
    await app.blank();
    await setClipboard(app.page, { text: 'Rich text', html });
    await app.menu('Edit', 'Paste Special');
    await dialog(app.page, 'Paste Special').getByRole('button', { name: 'OK' }).click();
    await expect.poll(() => app.text()).toBe('Rich text');
    expect(await downloadDocumentXml(app)).toContain('<w:b/>');
  });

  test('the unformatted choice pastes plain text only', async ({ app }) => {
    await app.blank();
    await setClipboard(app.page, { text: 'Rich text', html });
    await app.menu('Edit', 'Paste Special');
    const box = dialog(app.page, 'Paste Special');
    await box.getByRole('radio', { name: 'Unformatted text' }).check();
    await box.getByRole('button', { name: 'OK' }).click();
    await expect.poll(() => app.text()).toBe('Rich text');
    expect(await downloadDocumentXml(app)).not.toContain('<w:b/>');
  });

  test('a clipboard with plain text only offers just the unformatted choice', async ({ app }) => {
    await app.blank();
    await setClipboard(app.page, { text: 'only plain' });
    await app.menu('Edit', 'Paste Special');
    const box = dialog(app.page, 'Paste Special');
    await expect(box.getByRole('radio')).toHaveCount(1);
    await expect(box.getByRole('radio', { name: 'Unformatted text' })).toBeChecked();
    await box.getByRole('button', { name: 'OK' }).click();
    await expect.poll(() => app.text()).toBe('only plain');
  });

  test('the close button and Escape dismiss it', async ({ app }) => {
    await app.blank();
    await setClipboard(app.page, { text: 'x' });
    await app.menu('Edit', 'Paste Special');
    const box = dialog(app.page, 'Paste Special');
    await box.getByRole('button', { name: 'Close' }).click();
    await expect(box).toHaveCount(0);
    await app.menu('Edit', 'Paste Special');
    await expect(box).toBeVisible();
    await app.page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    await expect.poll(() => app.text()).toBe('');
  });

  test('typing resumes in the document after the dialog closes', async ({ app }) => {
    await app.blank();
    await setClipboard(app.page, { text: 'pasted ' });
    await app.menu('Edit', 'Paste Special');
    await dialog(app.page, 'Paste Special').getByRole('button', { name: 'OK' }).click();
    await expect.poll(() => app.text()).toBe('pasted ');
    await expect(app.editor).toBeFocused();
    await app.page.keyboard.type('typed');
    await expect.poll(() => app.text()).toBe('pasted typed');
  });
});
