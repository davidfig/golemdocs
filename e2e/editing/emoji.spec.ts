// Emoji in a document: each sequence (a ZWJ family, a flag, a skin tone) is laid out as one color glyph from a lazily
// loaded emoji page, and the caret, selection and Backspace treat it as one character.

import { test, expect } from '../fixtures';
import { convertTo } from '../files/helpers';
import { decodePdf } from '../pdf/helpers';

const FAMILY = '👨‍👩‍👧‍👦';
const FLAG = '🇯🇵';
const THUMB = '👍🏽';

/** The emoji drawn on the first page: how many glyphs, from how many faces, and whether their atlases have arrived. */
function emojiOnPage(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const pages = (window as unknown as { pages: { text: { face: { color: boolean; ready: boolean; key: string }; count: number }[] }[] }).pages;
    const batches = pages[0].text.filter((b) => b.face.color);
    return { glyphs: batches.reduce((n, b) => n + b.count, 0), ready: batches.every((b) => b.face.ready), keys: [...new Set(batches.map((b) => b.face.key))] };
  });
}

test.describe('emoji', () => {
  test('a typed emoji sequence is one color glyph', async ({ app }) => {
    await app.blank();
    await app.editor.focus();
    await app.page.keyboard.insertText(`a${FAMILY}b${FLAG} ${THUMB}`);
    await expect.poll(() => app.text()).toBe(`a${FAMILY}b${FLAG} ${THUMB}`);
    await expect.poll(() => emojiOnPage(app.page)).toMatchObject({ glyphs: 3, ready: true });
    const { keys } = await emojiOnPage(app.page);
    for (const key of keys) expect(key).toMatch(/^emoji-\d+\/regular\.webp$/);
  });

  test('the caret, selection and Backspace treat a sequence as one character', async ({ app }) => {
    await app.blank();
    await app.editor.focus();
    await app.page.keyboard.insertText(`x${FAMILY}${FLAG}`);
    await expect.poll(() => app.text()).toBe(`x${FAMILY}${FLAG}`);
    await app.press('End');
    await app.press('Shift+ArrowLeft');
    await expect.poll(() => app.selectedText()).toBe(FLAG);
    await app.press('ArrowLeft');
    await app.press('Shift+ArrowLeft');
    await expect.poll(() => app.selectedText()).toBe(FAMILY);
    await app.press('End');
    await app.press('Backspace');
    await app.press('Backspace');
    await expect.poll(() => app.text()).toBe('x');
  });

  test('PDF export draws each emoji as a picture', async ({ app }) => {
    await app.blank();
    await app.editor.focus();
    await app.page.keyboard.insertText(`Hi ${FAMILY} ${FLAG} ${FLAG}`);
    await expect.poll(() => app.text()).toBe(`Hi ${FAMILY} ${FLAG} ${FLAG}`);
    await convertTo(app, 'PDF (.pdf)', 'PDF');
    const file = await app.download(() => app.menu('File', 'Download'));
    const pdf = decodePdf(file.bytes);
    // Two sprites (the flag is embedded once), each an RGB image with its alpha as a soft mask.
    expect(pdf.match(/\/Subtype\s*\/Image/g)?.length).toBe(4);
    expect(pdf).toContain('/SMask');
  });

  test('a document without emoji loads no emoji page', async ({ app }) => {
    await app.blank();
    await app.type('Plain text only.');
    await expect.poll(() => app.text()).toBe('Plain text only.');
    const fetched = await app.page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\/fonts\/emoji-/.test(n)));
    expect(fetched).toEqual([]);
  });
});
