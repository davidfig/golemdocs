// Editing a text file of 8 MB or more in the large-text editor: the caret, typing, Enter and Backspace, selecting by dragging,
// the clipboard, undo and redo, replacing, and downloading the file with the changes. The text is drawn on the canvas, so these
// read what is on screen through `window.textEditor` (see large-helpers.ts) and click at the positions it gives.

import { MOD, expect, test } from './fixtures';
import { importFile, waitForSaved } from './helpers';
import { clickAt, clickNumber, dragFrom, expectLine, largeStatus, lineText, openBigFile, pointOf, state, viewer, statusBarOn } from './large-helpers';

test.beforeEach(({ page }) => statusBarOn(page));

const LINES = 150_000;

/** ~9 MB of numbered lines. */
const BIG = Buffer.from(Array.from({ length: LINES }, (_, i) => `Line ${i + 1} the quick brown fox jumps over the lazy dog ${'.'.repeat(12)}`).join('\n') + '\n', 'utf8');

const open = (app: Parameters<typeof openBigFile>[0], name = 'big.txt', buffer: Buffer = BIG) => openBigFile(app, name, buffer, LINES);

test('clicking puts the caret in a line and typing changes it', async ({ app, page }) => {
  await open(app);
  await clickAt(page, 2, 0);
  await expect.poll(async () => (await state(page)).caret).toEqual({ line: 2, col: 0 });
  await page.keyboard.type('abc');
  await expectLine(page, 2, /^abcLine 3 the quick/);
  expect((await state(page)).caret).toEqual({ line: 2, col: 3 });
  await page.keyboard.press('Backspace');
  await expectLine(page, 2, /^abLine 3 the quick/);
  await page.keyboard.press('Delete');
  await expectLine(page, 2, /^abine 3 the quick/);
});

test('Enter splits a line, Backspace at the start joins it again, and the line count follows', async ({ app, page }) => {
  await open(app);
  await clickAt(page, 0, 0);
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expectLine(page, 0, 'Line ');
  await expectLine(page, 1, /^1 the quick/);
  await expect(largeStatus(page)).toContainText(`${(LINES + 1).toLocaleString('en-US')} lines`);
  await page.keyboard.press('Backspace');
  await expectLine(page, 0, /^Line 1 the quick/);
  await expect(largeStatus(page)).toContainText(`${LINES.toLocaleString('en-US')} lines`);
});

test('the arrow keys move the caret by character, line and word', async ({ app, page }) => {
  await open(app);
  await clickAt(page, 0, 0);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await expectLine(page, 2, /\.\.\.!$/);
  await page.keyboard.press('Home');
  await page.keyboard.press('Alt+ArrowRight');
  await page.keyboard.type('#');
  await expectLine(page, 2, /^Line #3 /);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('^');
  await expect.poll(async () => (await lineText(page, 1)) ?? '').toContain('^');
});

test('dragging selects text, and typing replaces it; undo and redo walk back and forth', async ({ app, page }) => {
  await open(app);
  await dragFrom(page, [0, 0], [0, 6]);
  await expect.poll(async () => (await state(page)).selected).toBe('Line 1');
  await page.keyboard.type('X');
  await expectLine(page, 0, /^X the quick/);
  await page.keyboard.press(`${MOD}+z`);
  await expectLine(page, 0, /^Line 1 the quick/);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await expectLine(page, 0, /^X the quick/);
});

test('a double click selects a word, a triple click the line', async ({ app, page }) => {
  await open(app);
  await clickAt(page, 0, 8, { clickCount: 2 });
  await expect.poll(async () => (await state(page)).selected).toBe('the');
  await clickAt(page, 0, 8, { clickCount: 3 });
  await expect.poll(async () => (await state(page)).selected).toBe('Line 1 the quick brown fox jumps over the lazy dog ............');
});

test('Shift+click and Shift+arrows extend the selection', async ({ app, page }) => {
  await open(app);
  await clickAt(page, 0, 2);
  await clickAt(page, 1, 5, { modifiers: ['Shift'] });
  await expect.poll(async () => (await state(page)).selected).toBe('ne 1 the quick brown fox jumps over the lazy dog ............\nLine ');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await state(page)).selected).toBeNull();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await state(page)).selected).toHaveLength(2);
});

test('Select All and copy, and pasted text with line breaks adds lines', async ({ app, page }) => {
  await open(app);
  await clickAt(page, 0, 0);
  await page.evaluate(() => navigator.clipboard.writeText('one\ntwo\nthree'));
  await page.keyboard.press(`${MOD}+v`);
  await expectLine(page, 0, 'one');
  await expectLine(page, 2, /^threeLine 1 the quick/);
  await expect(largeStatus(page)).toContainText(`${(LINES + 2).toLocaleString('en-US')} lines`);
});

test('the edited file downloads with the changes, and nothing else changed', async ({ app, page }) => {
  await open(app);
  await clickAt(page, 1, 0);
  await page.keyboard.type('EDITED ');
  const file = await app.download(() => app.menu('File', 'Download'));
  const expected = Buffer.from(BIG.toString('utf8').replace('Line 2 the quick', 'EDITED Line 2 the quick'), 'utf8');
  expect(file.bytes.length).toBe(expected.length);
  expect(file.bytes.equals(expected)).toBe(true);
});

// A few hundred matches in a file of 150,000 lines: replacing every match of a word on every line is a different, much slower job
// (it timed out when the machine was busy) and says nothing more about "one step that can be undone".
const MARKED = 200;
const BIG_MARKED = Buffer.from(
  Array.from({ length: LINES }, (_, i) => `Line ${i + 1} the ${i < MARKED ? 'marked' : 'quick brown'} fox jumps over the lazy dog ${'.'.repeat(12)}`).join('\n') + '\n',
  'utf8',
);

test('Replace All changes every match as one step that can be undone', async ({ app, page }) => {
  await open(app, 'marked.txt', BIG_MARKED);
  await app.menu('Edit', 'Replace…');
  await viewer(page).getByRole('textbox', { name: 'Find' }).fill('marked');
  await viewer(page).getByRole('textbox', { name: 'Replace with' }).fill('changed');
  await viewer(page).getByRole('button', { name: 'Replace all' }).click();
  await expect(viewer(page).locator('.wm-large-message')).toContainText(`Replaced ${MARKED} matches`, { timeout: 30_000 });
  await expectLine(page, 0, /^Line 1 the changed fox/);
  await page.keyboard.press('Escape');
  await clickAt(page, 0, 0);
  await page.keyboard.press(`${MOD}+z`);
  await expectLine(page, 0, /^Line 1 the marked fox/);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await expectLine(page, 0, /^Line 1 the changed fox/);
});

test('Replace takes the matches one at a time', async ({ app, page }) => {
  await open(app);
  await app.menu('Edit', 'Replace…');
  await viewer(page).getByRole('textbox', { name: 'Find' }).fill('Line 2 ');
  await viewer(page).getByRole('textbox', { name: 'Replace with' }).fill('Row 2 ');
  await viewer(page).getByRole('button', { name: 'Replace', exact: true }).click(); // selects the first match
  await expect.poll(async () => (await state(page)).selected).toBe('Line 2 ');
  await viewer(page).getByRole('button', { name: 'Replace', exact: true }).click(); // replaces it
  await expectLine(page, 1, /^Row 2 the quick/);
});

test('an edited file is saved in this browser by itself, and a reload brings it back with the edit', async ({ app, page }) => {
  await open(app);
  await clickAt(page, 1, 0);
  await page.keyboard.type('KEPT ');
  await waitForSaved(page, 'big.txt');
  await expect.poll(() => page.url()).toMatch(/doc=local%3A[\w-]+/);
  await page.reload();
  await expect(viewer(page)).toBeVisible({ timeout: 30_000 });
  await expect(largeStatus(page)).toContainText(`${LINES.toLocaleString('en-US')} lines`, { timeout: 30_000 });
  await expectLine(page, 1, /^KEPT Line 2 the quick/);
  // It was kept as the text file it is: a download gives the edited text.
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('big.txt');
  expect(file.bytes.length).toBe(BIG.length + 5);
});

test('a file that was only looked at is not saved', async ({ app, page }) => {
  await open(app);
  await page.waitForTimeout(2500);
  expect(new URL(page.url()).searchParams.get('doc') ?? '').not.toMatch(/^local:/);
});

test('a UTF-16 file is saved back as UTF-16', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  const text = BIG.toString('utf8');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  await importFile(app, { name: 'wide.txt', buffer: utf16 });
  await expect(viewer(page)).toBeVisible();
  await expect(largeStatus(page)).toContainText(`${LINES.toLocaleString('en-US')} lines`, { timeout: 30_000 });
  await expect.poll(async () => (await state(page)).glyphs, { timeout: 15_000 }).toBeGreaterThan(0);
  await clickAt(page, 0, 0);
  await page.keyboard.type('é');
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))).toBe(true);
  expect(file.bytes.length).toBe(utf16.length + 2);
  expect(file.bytes.subarray(2, 8).toString('utf16le')).toBe('éLi');
});

test('File › Open Selection as Document opens the selected lines as an ordinary document', async ({ app, page }) => {
  await open(app);
  await clickNumber(page, 0);
  await clickNumber(page, 2, { modifiers: ['Shift'] });
  await app.menu('File', 'Open Selection as Document');
  await expect(viewer(page)).toBeHidden();
  await expect(page).toHaveTitle(/^big \(selection\)\.txt - Golem Docs/);
  await expect.poll(() => app.text()).toBe(
    'Line 1 the quick brown fox jumps over the lazy dog ............\nLine 2 the quick brown fox jumps over the lazy dog ............\nLine 3 the quick brown fox jumps over the lazy dog ............',
  );
});

test('without wrapping, the view scrolls sideways to keep the caret in sight', async ({ app, page }) => {
  const long = Buffer.from(Array.from({ length: LINES }, (_, i) => (i === 0 ? `START ${'0123456789'.repeat(400)} END` : `Line ${i + 1} the quick brown fox jumps over the lazy dog ${'.'.repeat(12)}`)).join('\n') + '\n', 'utf8');
  await open(app, 'wide.txt', long);
  await page.keyboard.press('Alt+z'); // wrapping off
  await expect.poll(async () => (await state(page)).wrap).toBe(false);
  await clickAt(page, 0, 0);
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await expectLine(page, 0, / END!$/);
  await expect.poll(async () => (await state(page)).cameraX).toBeGreaterThan(100);
  const canvas = (await page.locator('#canvas').boundingBox())!;
  const caret = await pointOf(page, 0, 4004);
  expect(caret.x).toBeGreaterThanOrEqual(canvas.x);
  expect(caret.x).toBeLessThanOrEqual(canvas.x + canvas.width);
});

test('text from an input method is shown as it is composed and typed in when it is done', async ({ app, page }) => {
  await open(app);
  await clickAt(page, 1, 0);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await expect.poll(async () => (await state(page)).composing).toBe('に');
  await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
  await expect.poll(async () => (await state(page)).composing).toBe('日本');
  await cdp.send('Input.insertText', { text: '日本' });
  await expect.poll(async () => (await state(page)).composing).toBeNull();
  await expectLine(page, 1, /^日本Line 2 the quick/);
});

test('undoing an edit made before filtering does not leave a wrong list of lines', async ({ app, page }) => {
  await open(app);
  await clickAt(page, 0, 0);
  await page.keyboard.press('Enter'); // a new first line
  await expect(largeStatus(page)).toContainText(`${(LINES + 1).toLocaleString('en-US')} lines`);
  await page.keyboard.press(`${MOD}+f`);
  await viewer(page).getByRole('textbox', { name: 'Find' }).fill('Line 9 ');
  await viewer(page).getByRole('button', { name: 'Show only matching lines' }).click();
  await expect(viewer(page).locator('.wm-large-message')).toContainText('matching lines');
  await page.keyboard.press('Escape');
  await page.keyboard.press(`${MOD}+z`);
  await expect(largeStatus(page)).toContainText(`${LINES.toLocaleString('en-US')} lines`);
  await expect.poll(async () => ((await state(page)).visible[0]?.text ?? '')).toContain('Line 9 ');
});

test('zooming scales the text and keeps typing and clicking exact', async ({ app, page }) => {
  await open(app);
  await app.menu('View', 'Zoom', 'Zoom In');
  await app.menu('View', 'Zoom', 'Zoom In');
  await expect.poll(async () => (await state(page)).zoom).toBeGreaterThan(1.3);
  // Zooming keeps the middle of the window where it was, so click a line and a column that are in view.
  const line = (await state(page)).visible[2].line;
  await clickAt(page, line, 40);
  await expect.poll(async () => (await state(page)).caret).toEqual({ line, col: 40 });
  await page.keyboard.type('Z');
  await expect.poll(async () => ((await lineText(page, line)) ?? '').charAt(40)).toBe('Z');
  expect((await state(page)).caret).toEqual({ line, col: 41 });
});
