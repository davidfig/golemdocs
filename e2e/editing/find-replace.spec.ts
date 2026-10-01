import { test, expect, type App } from '../fixtures';
import { DOC, MOD, caret, dialog, waitCaretSettled } from './helpers';

const TEXT = 'apple banana apple Cherry apple Apple';

const find = (app: App) => dialog(app.page, 'Find and Replace');
const query = (app: App) => find(app).getByRole('textbox', { name: 'Find what' });
const replacement = (app: App) => find(app).getByRole('textbox', { name: 'Replace with' });
const status = (app: App) => find(app).getByRole('status').first();

async function withText(app: App, text = TEXT) {
  await app.blank();
  await app.editor.focus();
  await app.page.keyboard.insertText(text);
  await expect.poll(() => app.text()).toBe(text);
  await app.press(`${DOC}+Home`);
}

async function openFind(app: App, tab: 'f' | 'h' | 'g' = 'f') {
  await app.press(tab === 'h' ? 'Control+h' : `${MOD}+${tab}`);
  await expect(find(app)).toBeVisible();
}

/**
 * Where the selected match ends: collapses the selection to its end (a match has no caret of its
 * own) and reads the caret. The next Find Next starts from there, so stepping forward still works.
 */
async function matchEnd(app: App): Promise<number> {
  await app.editor.focus();
  await app.press('ArrowRight');
  await expect.poll(() => app.selectedText()).toBe('');
  await waitCaretSettled(app);
  return (await caret(app))!.x;
}

test.describe('Find', () => {
  test('Ctrl/Cmd+F opens the dialog on the Find tab with the query focused and no Replace fields', async ({ app }) => {
    await withText(app);
    await openFind(app);
    await expect(find(app).getByRole('tab', { name: 'Find', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(query(app)).toBeFocused();
    await expect(replacement(app)).toBeHidden();
    await expect(find(app).getByRole('button', { name: 'Replace All' })).toBeHidden();
  });

  test('Edit ▸ Find opens it too', async ({ app }) => {
    await withText(app);
    await app.menu('Edit', 'Find');
    await expect(find(app)).toBeVisible();
  });

  test('typing a query selects the first match from the caret; Find Next steps through the matches and wraps', async ({ app }) => {
    await withText(app);
    await openFind(app);
    await query(app).fill('apple');
    await expect.poll(() => app.selectedText()).toBe('apple');
    const ends = [await matchEnd(app)];
    for (let i = 0; i < 4; i++) {
      await find(app).getByRole('button', { name: 'Find Next' }).click();
      await expect.poll(() => app.selectedText()).toMatch(/^apple$/i);
      ends.push(await matchEnd(app));
    }
    // Four matches in the line (apple, apple, apple, Apple), then back to the first.
    expect(new Set(ends.slice(0, 4)).size).toBe(4);
    expect([...ends.slice(0, 4)]).toEqual([...ends.slice(0, 4)].sort((a, b) => a - b));
    expect(ends[4]).toBe(ends[0]);
  });

  test('Enter finds the next and Shift+Enter the previous', async ({ app }) => {
    await withText(app);
    await openFind(app);
    await query(app).fill('apple');
    await expect.poll(() => app.selectedText()).toBe('apple');
    const first = await matchEnd(app);
    await find(app).getByRole('button', { name: 'Find Next' }).click();
    await expect.poll(() => app.selectedText()).toBe('apple');
    const second = await matchEnd(app);
    expect(second).toBeGreaterThan(first);

    // Start over, then two Enters and a Shift+Enter land on the second match.
    await app.press(`${DOC}+Home`);
    await query(app).fill('');
    await query(app).fill('apple');
    await expect.poll(() => app.selectedText()).toBe('apple');
    await query(app).press('Enter');
    await query(app).press('Enter');
    await query(app).press('Shift+Enter');
    await expect.poll(() => app.selectedText()).toBe('apple');
    expect(await matchEnd(app)).toBe(second);
  });

  test('matching ignores case unless Match case is checked', async ({ app }) => {
    await withText(app);
    await openFind(app);
    await query(app).fill('cherry');
    await expect.poll(() => app.selectedText()).toBe('Cherry');
    await find(app).getByRole('checkbox', { name: 'Match case' }).check();
    await query(app).press('Enter');
    await expect(status(app)).toHaveText('No matches');
    await query(app).fill('Cherry');
    await expect.poll(() => app.selectedText()).toBe('Cherry');
    await expect(status(app)).toHaveText('');
  });

  test('with Match case, "apple" skips "Apple" (three matches, not four)', async ({ app }) => {
    await withText(app);
    await openFind(app);
    await find(app).getByRole('checkbox', { name: 'Match case' }).check();
    await query(app).fill('apple');
    await expect.poll(() => app.selectedText()).toBe('apple');
    const seen = new Set([await matchEnd(app)]);
    for (let i = 0; i < 5; i++) {
      await find(app).getByRole('button', { name: 'Find Next' }).click();
      await expect.poll(() => app.selectedText()).toBe('apple');
      seen.add(await matchEnd(app));
    }
    expect(seen.size).toBe(3);
  });

  test('a query with no match says so and leaves the selection', async ({ app }) => {
    await withText(app);
    await openFind(app);
    await query(app).fill('zebra');
    await expect(status(app)).toHaveText('No matches');
    await query(app).fill('banana');
    await expect.poll(() => app.selectedText()).toBe('banana');
    await expect(status(app)).toHaveText('');
  });

  test('Find Next with an empty query does nothing', async ({ app }) => {
    await withText(app);
    await openFind(app);
    await find(app).getByRole('button', { name: 'Find Next' }).click();
    await expect.poll(() => app.selectedText()).toBe('');
    await expect(status(app)).toHaveText('');
  });

  test('selected text is the starting query when the dialog opens', async ({ app }) => {
    await withText(app);
    await app.press('Shift+ArrowRight', 5);
    await expect.poll(() => app.selectedText()).toBe('apple');
    await openFind(app);
    await expect(query(app)).toHaveValue('apple');
  });

  test('a multi-line selection is not used as the query', async ({ app }) => {
    await app.blank();
    await app.type('one');
    await app.press('Enter');
    await app.type('two');
    await app.press(`${MOD}+a`);
    await openFind(app);
    await expect(query(app)).toHaveValue('');
  });

  test('the dialog does not block the document: typing in the document works while it is open', async ({ app }) => {
    await withText(app, 'hello');
    await openFind(app);
    await app.editor.focus();
    await app.press(`${DOC}+End`);
    await app.page.keyboard.type('!');
    await expect(find(app)).toBeVisible();
    await expect.poll(() => app.text()).toBe('hello!');
  });

  test('Close, Escape and the title-bar close button dismiss it, and typing returns to the document', async ({ app }) => {
    await withText(app, 'hi');
    await openFind(app);
    await find(app).getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(find(app)).toBeHidden();
    await openFind(app);
    await app.page.keyboard.press('Escape');
    await expect(find(app)).toBeHidden();
    await expect(app.editor).toBeFocused();
  });

  test('Ctrl/Cmd+F again while open refocuses the query', async ({ app }) => {
    await withText(app);
    await openFind(app);
    await find(app).getByRole('checkbox', { name: 'Match case' }).focus();
    await app.page.keyboard.press(`${MOD}+f`);
    await expect(query(app)).toBeFocused();
  });
});

test.describe('Replace', () => {
  test('Ctrl+H opens the Replace tab with the extra field and buttons', async ({ app }) => {
    await withText(app);
    await openFind(app, 'h');
    await expect(find(app).getByRole('tab', { name: 'Replace', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(replacement(app)).toBeVisible();
    await expect(find(app).getByRole('button', { name: 'Replace', exact: true })).toBeVisible();
    await expect(find(app).getByRole('button', { name: 'Replace All' })).toBeVisible();
  });

  test('Edit ▸ Replace and the tabs switch between Find and Replace', async ({ app }) => {
    await withText(app);
    await app.menu('Edit', 'Replace');
    await expect(replacement(app)).toBeVisible();
    await find(app).getByRole('tab', { name: 'Find', exact: true }).click();
    await expect(replacement(app)).toBeHidden();
    await find(app).getByRole('tab', { name: 'Go To' }).click();
    await expect(find(app).getByRole('listbox', { name: 'Go to what' })).toBeVisible();
    await find(app).getByRole('tab', { name: 'Replace', exact: true }).click();
    await expect(replacement(app)).toBeVisible();
  });

  test('Replace swaps the selected match and moves on to the next', async ({ app }) => {
    await withText(app);
    await openFind(app, 'h');
    await query(app).fill('apple');
    await replacement(app).fill('pear');
    await expect.poll(() => app.selectedText()).toBe('apple');
    await find(app).getByRole('button', { name: 'Replace', exact: true }).click();
    // The next match is selected, ready for the next Replace.
    await expect.poll(() => app.selectedText()).toBe('apple');
    await find(app).getByRole('button', { name: 'Replace', exact: true }).click();
    await expect.poll(() => app.selectedText()).toBe('apple');
    await expect.poll(() => app.text()).toBe('pear banana pear Cherry apple Apple');
  });

  test('Replace All replaces every match, ignoring case, and reports the count', async ({ app }) => {
    await withText(app);
    await openFind(app, 'h');
    await query(app).fill('apple');
    await replacement(app).fill('fig');
    await find(app).getByRole('button', { name: 'Replace All' }).click();
    await expect(status(app)).toHaveText('Replaced 4');
    await expect.poll(() => app.text()).toBe('fig banana fig Cherry fig fig');
  });

  test('Replace All with Match case leaves other cases alone', async ({ app }) => {
    await withText(app);
    await openFind(app, 'h');
    await find(app).getByRole('checkbox', { name: 'Match case' }).check();
    await query(app).fill('apple');
    await replacement(app).fill('fig');
    await find(app).getByRole('button', { name: 'Replace All' }).click();
    await expect(status(app)).toHaveText('Replaced 3');
    await expect.poll(() => app.text()).toBe('fig banana fig Cherry fig Apple');
  });

  test('replacing with nothing deletes the matches', async ({ app }) => {
    await withText(app, 'a-b-c');
    await openFind(app, 'h');
    await query(app).fill('-');
    await find(app).getByRole('button', { name: 'Replace All' }).click();
    await expect.poll(() => app.text()).toBe('abc');
  });

  test('Replace All with no match reports No matches and changes nothing', async ({ app }) => {
    await withText(app);
    await openFind(app, 'h');
    await query(app).fill('zebra');
    await replacement(app).fill('x');
    await find(app).getByRole('button', { name: 'Replace All' }).click();
    await expect(status(app)).toHaveText('No matches');
    await expect.poll(() => app.text()).toBe(TEXT);
  });

  test('Replace All is one undo step', async ({ app }) => {
    await withText(app);
    await openFind(app, 'h');
    await query(app).fill('apple');
    await replacement(app).fill('fig');
    await find(app).getByRole('button', { name: 'Replace All' }).click();
    await expect.poll(() => app.text()).toBe('fig banana fig Cherry fig fig');
    await app.editor.focus();
    await app.press(`${MOD}+z`);
    await expect.poll(() => app.text()).toBe(TEXT);
  });

  test('Enter in the Replace with field replaces the current match', async ({ app }) => {
    await withText(app, 'cat cat');
    await openFind(app, 'h');
    await query(app).fill('cat');
    await replacement(app).fill('dog');
    await expect.poll(() => app.selectedText()).toBe('cat');
    await replacement(app).press('Enter');
    await expect.poll(() => app.text()).toBe('dog cat');
  });

  test('replacements can be longer and span paragraphs without breaking the document', async ({ app }) => {
    await app.blank();
    await app.type('x');
    await app.press('Enter');
    await app.type('x');
    await expect.poll(() => app.text()).toBe('x\nx');
    await openFind(app, 'h');
    await query(app).fill('x');
    await replacement(app).fill('longer text');
    await find(app).getByRole('button', { name: 'Replace All' }).click();
    await expect.poll(() => app.text()).toBe('longer text\nlonger text');
  });
});

test.describe('Go To', () => {
  async function twoPages(app: App) {
    await app.blank();
    await app.type('page one');
    await app.press(`${MOD}+Enter`);
    await app.type('page two');
    await app.press(`${MOD}+Enter`);
    await app.type('page three');
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { pages: unknown[] }).pages.length)).toBe(3);
  }
  const cameraY = (app: App) => app.page.evaluate(() => (window as unknown as { camera: { y: number } }).camera.y);
  const goToTab = (app: App) => find(app).getByRole('textbox', { name: 'Item number' });

  test('Ctrl/Cmd+G opens the Go To tab, with Page selected and the number field focused', async ({ app }) => {
    await twoPages(app);
    await openFind(app, 'g');
    await expect(find(app).getByRole('tab', { name: 'Go To' })).toHaveAttribute('aria-selected', 'true');
    await expect(find(app).getByRole('listbox', { name: 'Go to what' })).toHaveValue('page');
    await expect(goToTab(app)).toBeFocused();
    await expect(find(app).getByText('Enter page number:')).toBeVisible();
  });

  test('going to page numbers scrolls the view', async ({ app }) => {
    await twoPages(app);
    await openFind(app, 'g');
    await goToTab(app).fill('1');
    await goToTab(app).press('Enter');
    await expect.poll(() => cameraY(app)).toBeLessThan(10);
    const top = await cameraY(app);
    await goToTab(app).fill('3');
    await find(app).getByRole('button', { name: 'Go To', exact: true }).last().click();
    await expect.poll(() => cameraY(app)).toBeGreaterThan(top + 500);
    const third = await cameraY(app);
    await goToTab(app).fill('2');
    await goToTab(app).press('Enter');
    await expect.poll(async () => (await cameraY(app)) < third && (await cameraY(app)) > top).toBe(true);
  });

  test('+ and - move relative to the page in view; Previous and Next step', async ({ app }) => {
    await twoPages(app);
    await openFind(app, 'g');
    await goToTab(app).fill('1');
    await goToTab(app).press('Enter');
    await expect.poll(() => cameraY(app)).toBeLessThan(10);
    await goToTab(app).fill('+2');
    await goToTab(app).press('Enter');
    await expect.poll(() => cameraY(app)).toBeGreaterThan(1000);
    await goToTab(app).fill('-1');
    await goToTab(app).press('Enter');
    await expect.poll(async () => (await cameraY(app)) > 300 && (await cameraY(app)) < 1000).toBe(true);
    await find(app).getByRole('button', { name: 'Previous' }).click();
    await expect.poll(() => cameraY(app)).toBeLessThan(10);
    await find(app).getByRole('button', { name: 'Next' }).click();
    await expect.poll(() => cameraY(app)).toBeGreaterThan(300);
  });

  test('a page that does not exist says so; a non-number is refused', async ({ app }) => {
    await twoPages(app);
    await openFind(app, 'g');
    await goToTab(app).fill('9');
    await goToTab(app).press('Enter');
    await expect(find(app).getByText('There is no page 9. The document has 3.')).toBeVisible();
    await goToTab(app).fill('abc');
    await goToTab(app).press('Enter');
    await expect(find(app).getByText('Enter a number, like 3 or +2.')).toBeVisible();
  });

  test('a relative jump past the last page stops at the last page', async ({ app }) => {
    await twoPages(app);
    await openFind(app, 'g');
    await goToTab(app).fill('1');
    await goToTab(app).press('Enter');
    await expect.poll(() => cameraY(app)).toBeLessThan(10);
    await goToTab(app).fill('+50');
    await goToTab(app).press('Enter');
    await expect.poll(() => cameraY(app)).toBeGreaterThan(1000);
  });

  test('Comment: a document with no comments says so', async ({ app }) => {
    await twoPages(app);
    await openFind(app, 'g');
    await find(app).getByRole('listbox', { name: 'Go to what' }).selectOption('comment');
    await expect(find(app).getByText('Enter comment number:')).toBeVisible();
    await goToTab(app).fill('1');
    await goToTab(app).press('Enter');
    await expect(find(app).getByText('The document has no comments.')).toBeVisible();
    await find(app).getByRole('button', { name: 'Next' }).click();
    await expect(find(app).getByText('The document has no comments.')).toBeVisible();
  });

  test('Edit ▸ Go To opens it', async ({ app }) => {
    await app.blank();
    await app.menu('Edit', 'Go To');
    await expect(find(app).getByRole('tab', { name: 'Go To' })).toHaveAttribute('aria-selected', 'true');
  });

  test('Escape closes the dialog', async ({ app }) => {
    await app.blank();
    await openFind(app, 'g');
    await app.page.keyboard.press('Escape');
    await expect(find(app)).toBeHidden();
  });
});
