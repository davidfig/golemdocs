// Spelling in a plain text file open in the text editor: a misspelled word is marked (the worker checks the lines on screen), the
// right-click menu offers suggestions that replace it, and a file that is not prose (a log) is left alone.

import { expect, test } from './fixtures';
import { expectLine, openBigFile, pointOf, state, statusBarOn } from './large-helpers';

test.beforeEach(({ page }) => statusBarOn(page));

const LINES = 150_000;
const filler = (i: number) => `Line ${i + 1} the quick brown fox jumps over the lazy dog ${'.'.repeat(12)}`;
const make = (first: string) => Buffer.from([first, ...Array.from({ length: LINES - 1 }, (_, i) => filler(i + 1))].join('\n') + '\n', 'utf8');

test('a misspelled word is marked, and the right-click menu replaces it with a suggestion', async ({ app, page }) => {
  await openBigFile(app, 'prose.txt', make('This sentense has a mispelled word.'), LINES);
  await expect.poll(async () => (await state(page)).marks.filter((m) => m.line === 0).map((m) => m.text), { timeout: 20_000 }).toEqual(['sentense', 'mispelled']);
  const at = await pointOf(page, 0, 8);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const menu = page.locator('.wm-spell-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'sentence' }).click();
  await expectLine(page, 0, /^This sentence has a mispelled word\.$/);
});

test('a log is not spell checked', async ({ app, page }) => {
  await openBigFile(app, 'server.log', make('This sentense has a mispelled word.'), LINES);
  await page.waitForTimeout(1500);
  expect((await state(page)).marks).toEqual([]);
});

test('F7 steps through the problems of a text file, and Change types the suggestion over each', async ({ app, page }) => {
  await openBigFile(app, 'prose.txt', make('This sentense has a mispelled word.'), LINES);
  await page.keyboard.press('F7');
  const dialog = page.locator('dialog.wm-spell');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.wm-spell-problem')).toHaveText('sentense', { timeout: 20_000 });
  await expect.poll(async () => (await state(page)).selected).toBe('sentense');
  await dialog.getByRole('listbox', { name: 'Suggestions' }).getByRole('option', { name: 'sentence', exact: true }).click();
  await dialog.getByRole('button', { name: /^Change$/ }).click();
  await expect(dialog.locator('.wm-spell-problem')).toHaveText('mispelled');
  await expectLine(page, 0, /^This sentence has a mispelled word\.$/);
  await dialog.getByRole('button', { name: /Ignore Once/ }).click();
  await expect(dialog.getByText('The spelling and grammar check is complete.')).toBeVisible({ timeout: 20_000 });
});
