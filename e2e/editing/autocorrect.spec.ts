// Autocorrect as you type: smart quotes, dashes, ellipses, symbols, capitals and links, each with a setting in Tools ▸ Options.

import { expect, test } from '../fixtures';
import { docxPart } from './helpers';

test.describe('Autocorrect as you type', () => {
  test.use({ autoCorrectDefault: true });

  test('quotes, dashes, an ellipsis, symbols and capitals are corrected as they are typed', async ({ app }) => {
    await app.blank();
    await app.type('he said "wait... it\'s (c) 2026--ok" and 1/2 -> done');
    await expect.poll(() => app.text()).toBe('He said “wait… it’s © 2026—ok” and ½ → done');
  });

  test('Backspace right after a correction gives back what was typed', async ({ app }) => {
    await app.blank();
    // Reading the text moves the caret, which ends the chance to take a correction back: Backspace comes first.
    await app.type('Wait...');
    await app.settle();
    await app.press('Backspace');
    await expect.poll(() => app.text()).toBe('Wait...');
    await app.type('"');
    await app.settle();
    await app.press('Backspace');
    await app.type('x');
    await expect.poll(() => app.text()).toBe('Wait..."x');
  });

  test('a web address followed by a space becomes a link, and a raised ordinal is made', async ({ app }) => {
    await app.blank();
    await app.type('See https://example.com/a. On the 1st day');
    await expect.poll(() => app.text()).toBe('See https://example.com/a. On the 1st day');
    const word = await app.download(() => app.menu('File', 'Download'));
    expect(docxPart(word.bytes, 'word/_rels/document.xml.rels')).toContain('Target="https://example.com/a"');
    expect(docxPart(word.bytes, 'word/document.xml')).toContain('w:val="superscript"');
  });

  test('every rule can be turned off in Tools ▸ Options, and is kept', async ({ app }) => {
    await app.blank();
    await app.menu('Tools', 'Options');
    const options = app.page.getByRole('dialog', { name: 'Options' });
    for (const label of ['Replace straight quotes with smart quotes', 'Capitalize the first letter of sentences', 'Replace three dots with an ellipsis (…)']) {
      const box = options.getByRole('checkbox', { name: label });
      await expect(box).toBeChecked();
      await box.uncheck();
    }
    await options.getByRole('button', { name: 'OK' }).click();
    await expect(options).toHaveCount(0);
    expect(await app.page.evaluate(() => localStorage.getItem('word.autoCorrect'))).toBe('["quotes","ellipsis","capitalize"]');
    await app.focus();
    await app.type('say "hi"... ok--yes');
    await expect.poll(() => app.text()).toBe('say "hi"... ok—yes');
  });

  test('common typos are corrected, and the user\u2019s own list replaces text, kept in Tools ▸ Options ▸ Edit List', async ({ app }) => {
    await app.blank();
    await app.type('I recieve teh mail. ');
    await expect.poll(() => app.text()).toBe('I receive the mail. ');
    await app.menu('Tools', 'Options');
    const options = app.page.getByRole('dialog', { name: 'Options' });
    await options.getByRole('button', { name: 'Edit List…' }).click();
    const list = app.page.getByRole('dialog', { name: 'Replacement List' });
    await list.getByRole('button', { name: 'Add' }).click();
    await list.getByRole('textbox', { name: 'Text' }).fill('omw');
    await list.getByRole('textbox', { name: 'Replace with' }).fill('on my way');
    await list.getByRole('textbox', { name: 'Replace with' }).press('Tab');
    await list.getByRole('button', { name: 'Add' }).click();
    await list.getByRole('textbox', { name: 'Text' }).last().fill('teh');
    await list.getByRole('textbox', { name: 'Replace with' }).last().fill('teh');
    await list.getByRole('textbox', { name: 'Replace with' }).last().press('Tab');
    expect(await app.page.evaluate(() => localStorage.getItem('word.replacements.v1'))).toBe('[["omw","on my way"],["teh","teh"]]');
    await list.getByRole('button', { name: 'OK' }).click();
    await options.getByRole('button', { name: 'OK' }).click();
    await app.focus();
    await app.type('Ok omw, and teh end');
    await expect.poll(() => app.text()).toBe('I receive the mail. Ok on my way, and teh end');
  });
});
