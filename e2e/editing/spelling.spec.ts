import { test, expect, type App } from '../fixtures';
import { DOC, MOD, clickAt, dialog, lineGaps, tool, waitCaretSettled } from './helpers';

const spell = (app: App) => dialog(app.page, 'Spelling and Grammar: English (U.S.)');
const btn = (app: App, name: string) => spell(app).getByRole('button', { name, exact: true }).last();

async function withText(app: App, text: string) {
  await app.blank();
  await app.editor.focus();
  await app.page.keyboard.insertText(text);
  await expect.poll(() => app.text()).toBe(text);
  await app.press(`${DOC}+Home`);
}

async function openSpelling(app: App) {
  await app.press('F7');
  await expect(spell(app)).toBeVisible();
}

test.describe('Spelling and Grammar dialog', () => {
  test('F7 opens the dialog and selects the first misspelled word with suggestions', async ({ app }) => {
    await withText(app, 'I recieve mail.');
    await openSpelling(app);
    await expect.poll(() => app.selectedText()).toBe('recieve');
    await expect(spell(app).getByText('Not in Dictionary:')).toBeVisible();
    await expect(spell(app).locator('.wm-spell-problem')).toHaveText('recieve');
    const suggestions = spell(app).getByRole('listbox', { name: 'Suggestions' });
    await expect(suggestions.getByRole('option', { name: 'receive', exact: true })).toBeVisible();
  });

  test('the toolbar button and Tools ▸ Spelling and Grammar open it', async ({ app }) => {
    await withText(app, 'I recieve mail.');
    await tool(app, 'Spelling and Grammar').click();
    await expect(spell(app)).toBeVisible();
    await btn(app, 'Close').click();
    await expect(spell(app)).toBeHidden();
    await app.menu('Tools', 'Spelling and Grammar');
    await expect(spell(app)).toBeVisible();
  });

  test('Change replaces the word with the chosen suggestion and moves to the next problem', async ({ app }) => {
    await withText(app, 'I recieve teh mail.');
    await openSpelling(app);
    await expect.poll(() => app.selectedText()).toBe('recieve');
    await spell(app).getByRole('listbox', { name: 'Suggestions' }).selectOption('receive');
    await btn(app, 'Change').click();
    await expect.poll(() => app.selectedText()).toBe('teh');
    await expect.poll(() => app.text()).toBe('I receive teh mail.');
  });

  test('double-clicking a suggestion changes the word', async ({ app }) => {
    await withText(app, 'I recieve mail.');
    await openSpelling(app);
    await spell(app).getByRole('option', { name: 'receive', exact: true }).dblclick();
    await expect(spell(app).getByText('The spelling and grammar check is complete.')).toBeVisible();
    await expect.poll(() => app.text()).toBe('I receive mail.');
  });

  test('Ignore Once skips the word without changing it, and it is asked about again on Check Again', async ({ app }) => {
    await withText(app, 'recieve and recieve');
    await openSpelling(app);
    await expect.poll(() => app.selectedText()).toBe('recieve');
    await btn(app, 'Ignore Once').click();
    await expect.poll(() => app.selectedText()).toBe('recieve');
    await btn(app, 'Ignore Once').click();
    await expect(spell(app).getByText('The spelling and grammar check is complete.')).toBeVisible();
    await expect.poll(() => app.text()).toBe('recieve and recieve');
    await expect(btn(app, 'Check Again')).toBeVisible();
    await btn(app, 'Check Again').click();
    await expect(spell(app).locator('.wm-spell-problem')).toHaveText('recieve');
  });

  test('Ignore All skips every occurrence of the word', async ({ app }) => {
    await withText(app, 'recieve teh recieve');
    await openSpelling(app);
    await expect.poll(() => app.selectedText()).toBe('recieve');
    await btn(app, 'Ignore All').click();
    await expect.poll(() => app.selectedText()).toBe('teh');
    await btn(app, 'Ignore Once').click();
    await expect(spell(app).getByText('The spelling and grammar check is complete.')).toBeVisible();
  });

  test('Change All fixes every occurrence', async ({ app }) => {
    await withText(app, 'recieve it, then recieve it again');
    await openSpelling(app);
    await expect.poll(() => app.selectedText()).toBe('recieve');
    await btn(app, 'Change All').click();
    await expect(spell(app).getByText('The spelling and grammar check is complete.')).toBeVisible();
    await expect.poll(() => app.text()).toBe('receive it, then receive it again');
  });

  test('Add to Dictionary accepts the word from then on, in this and other documents', async ({ app }) => {
    await withText(app, 'the florbnatic arrived');
    await openSpelling(app);
    await expect.poll(() => app.selectedText()).toBe('florbnatic');
    await btn(app, 'Add to Dictionary').click();
    await expect(spell(app).getByText('The spelling and grammar check is complete.')).toBeVisible();
    await expect.poll(() => app.page.evaluate(() => Object.values(localStorage).join('|'))).toContain('florbnatic');
    // A new document in the same browser profile accepts it too.
    await btn(app, 'Close').click();
    await app.menu('File', 'New');
    await app.focus();
    await app.editor.focus();
    await app.page.keyboard.insertText('florbnatic again');
    await openSpelling(app);
    await expect(spell(app).getByText('The spelling and grammar check is complete.')).toBeVisible();
  });

  test('a document with no problems says the check is complete straight away', async ({ app }) => {
    await withText(app, 'All the words here are spelled correctly.');
    await openSpelling(app);
    await expect(spell(app).getByText('The spelling and grammar check is complete.')).toBeVisible();
    await expect(btn(app, 'Change')).toBeHidden();
  });

  test('a word with no suggestions offers none and cannot be changed', async ({ app }) => {
    await withText(app, 'qqqqzzzzxxxxwwww');
    await openSpelling(app);
    await expect.poll(() => app.selectedText()).toBe('qqqqzzzzxxxxwwww');
    await expect(btn(app, 'Change')).toBeDisabled();
    await expect(btn(app, 'Change All')).toBeDisabled();
  });

  test('the check starts from the caret, not the top', async ({ app }) => {
    await withText(app, 'teh first, recieve second');
    await app.press('ArrowRight', 8);
    await openSpelling(app);
    await expect.poll(() => app.selectedText()).toBe('recieve');
  });

  test('numbers, ALL-CAPS words and addresses are not flagged', async ({ app }) => {
    await withText(app, 'NASA 12345 info@example.com https://example.org/x');
    await openSpelling(app);
    await expect(spell(app).getByText('The spelling and grammar check is complete.')).toBeVisible();
  });

  test('Close and Escape dismiss the dialog, and typing returns to the document', async ({ app }) => {
    await withText(app, 'I recieve mail.');
    await openSpelling(app);
    await app.page.keyboard.press('Escape');
    await expect(spell(app)).toBeHidden();
    await expect(app.editor).toBeFocused();
  });

  test('if the selection is moved away, Change asks to use Ignore Once to go on', async ({ app }) => {
    await withText(app, 'recieve teh');
    await openSpelling(app);
    await expect.poll(() => app.selectedText()).toBe('recieve');
    await app.editor.focus();
    await app.press(`${DOC}+End`);
    await spell(app).getByRole('option').first().click();
    await btn(app, 'Change').click();
    await expect(spell(app).getByText('The selection changed. Choose Ignore Once to go on.')).toBeVisible();
    await expect.poll(() => app.text()).toBe('recieve teh');
  });
});

test.describe('grammar', () => {
  test('a repeated word is reported as grammar, with Ignore Rule instead of Add to Dictionary', async ({ app }) => {
    await withText(app, 'We saw the the dog.');
    await openSpelling(app);
    await expect(spell(app).getByText('Grammar: Repeated word')).toBeVisible();
    await expect(btn(app, 'Ignore Rule')).toBeVisible();
    await expect(btn(app, 'Add to Dictionary')).toBeHidden();
    await expect(btn(app, 'Change All')).toBeHidden();
  });

  test('Change applies the grammar suggestion', async ({ app }) => {
    await withText(app, 'We saw the the dog.');
    await openSpelling(app);
    await expect(spell(app).getByText('Grammar: Repeated word')).toBeVisible();
    await btn(app, 'Change').click();
    await expect.poll(() => app.text()).toMatch(/^We saw the dog\.$|^We saw the  ?dog\.$/);
  });

  test('turning off Check grammar leaves only spelling problems', async ({ app }) => {
    await withText(app, 'We saw the the dog.');
    await openSpelling(app);
    await expect(spell(app).getByText('Grammar: Repeated word')).toBeVisible();
    await spell(app).getByRole('checkbox', { name: 'Check grammar' }).uncheck();
    await expect(spell(app).getByText('The spelling and grammar check is complete.')).toBeVisible();
    await spell(app).getByRole('checkbox', { name: 'Check grammar' }).check();
    await expect(spell(app).getByText('Grammar: Repeated word')).toBeVisible();
  });

  test('Ignore Rule stops that kind of problem being reported', async ({ app }) => {
    await withText(app, 'the the cat and a the the dog');
    await openSpelling(app);
    await expect(spell(app).getByText('Grammar: Repeated word')).toBeVisible();
    await btn(app, 'Ignore Rule').click();
    await expect(spell(app).getByText('The spelling and grammar check is complete.')).toBeVisible();
  });

  test('the check-grammar choice is remembered in this browser', async ({ app }) => {
    await withText(app, 'We saw the the dog.');
    await openSpelling(app);
    await spell(app).getByRole('checkbox', { name: 'Check grammar' }).uncheck();
    await expect.poll(() => app.page.evaluate(() => localStorage.getItem('word.spelling.grammar'))).toBe('off');
    await app.page.reload();
    await app.ready();
    await app.menu('File', 'New');
    await app.focus();
    await app.press('F7');
    await expect(spell(app).getByRole('checkbox', { name: 'Check grammar' })).not.toBeChecked();
  });
});

test.describe('squiggles and the right-click menu', () => {
  const menu = (app: App) => app.page.getByRole('menu', { name: 'Spelling and Grammar: English (U.S.)' });

  async function rightClickWord(app: App, text: string, from: number, to: number) {
    await app.blank();
    await app.editor.focus();
    await app.page.keyboard.insertText(text);
    await expect.poll(() => app.text()).toBe(text);
    await app.press('ArrowLeft', 0);
    const gaps = await lineGaps(app, text.length);
    await clickAt(app, { x: (gaps[from].x + gaps[to].x) / 2, y: gaps[0].y }, { button: 'right' });
  }

  test('right-clicking a misspelled word offers suggestions, Ignore All and Add to Dictionary', async ({ app }) => {
    await rightClickWord(app, 'I recieve mail.', 2, 9);
    await expect(menu(app)).toBeVisible();
    await expect(menu(app).getByRole('menuitem', { name: 'receive', exact: true })).toBeVisible();
    await expect(menu(app).getByRole('menuitem', { name: 'Ignore All' })).toBeVisible();
    await expect(menu(app).getByRole('menuitem', { name: 'Add to Dictionary' })).toBeVisible();
    await app.press('Escape');
    await expect(menu(app)).toBeHidden();
  });

  test('choosing a suggestion fixes the word', async ({ app }) => {
    await rightClickWord(app, 'I recieve mail.', 2, 9);
    await menu(app).getByRole('menuitem', { name: 'receive', exact: true }).click();
    await expect(menu(app)).toBeHidden();
    await expect.poll(() => app.text()).toBe('I receive mail.');
  });

  test('Ignore All from the menu stops the word being marked', async ({ app }) => {
    await rightClickWord(app, 'I recieve mail.', 2, 9);
    await menu(app).getByRole('menuitem', { name: 'Ignore All' }).click();
    await app.press(`${DOC}+Home`);
    await app.press('F7');
    await expect(spell(app).getByText('The spelling and grammar check is complete.')).toBeVisible();
  });

  test('Add to Dictionary from the menu is remembered', async ({ app }) => {
    await rightClickWord(app, 'a zorbulant day', 2, 10);
    await menu(app).getByRole('menuitem', { name: 'Add to Dictionary' }).click();
    await expect.poll(() => app.page.evaluate(() => Object.values(localStorage).join('|'))).toContain('zorbulant');
  });

  test('right-clicking a correctly spelled word opens no spelling menu', async ({ app }) => {
    await rightClickWord(app, 'I receive mail.', 2, 9);
    await app.page.waitForTimeout(400);
    await expect(menu(app)).toHaveCount(0);
  });

  test('right-clicking a grammar problem offers the suggestion and Ignore Rule', async ({ app }) => {
    await rightClickWord(app, 'We saw the the dog.', 7, 14);
    await expect(menu(app)).toBeVisible();
    await expect(menu(app).getByText('Repeated word')).toBeVisible();
    await expect(menu(app).getByRole('menuitem', { name: 'Ignore Rule' })).toBeVisible();
    await expect(menu(app).getByRole('menuitem', { name: 'Add to Dictionary' })).toHaveCount(0);
    await app.press('Escape');
  });

  test('with "Check spelling as you type" off there is no spelling menu', async ({ app }) => {
    await withText(app, 'I recieve mail.');
    await openSpelling(app);
    await spell(app).getByRole('checkbox', { name: 'Check spelling as you type' }).uncheck();
    await spell(app).getByRole('checkbox', { name: 'Check grammar' }).uncheck();
    await btn(app, 'Close').click();
    await expect(spell(app)).toBeHidden();
    const gaps = await lineGaps(app, 'I recieve mail.'.length);
    await clickAt(app, { x: (gaps[2].x + gaps[9].x) / 2, y: gaps[0].y }, { button: 'right' });
    await app.page.waitForTimeout(400);
    await expect(menu(app)).toHaveCount(0);
  });

  void MOD;
  void waitCaretSettled;
});
