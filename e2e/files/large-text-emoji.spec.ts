// Emoji in a text file shown in the large-text editor: a whole sequence is one character of two cells, so the caret steps
// over it at once.

import { expect, test } from './fixtures';
import { expectLine, openBigFile, state, statusBarOn } from './large-helpers';

test.beforeEach(({ page }) => statusBarOn(page));

const LINES = 150_000;
const FAMILY = '👨‍👩‍👧‍👦';
const BIG = Buffer.from([`go ${FAMILY}${'🇯🇵'} end`, ...Array.from({ length: LINES - 1 }, (_, i) => `Line ${i + 2} the quick brown fox jumps over the lazy dog ${'.'.repeat(12)}`)].join('\n') + '\n', 'utf8');

test('an emoji sequence is one character of two cells', async ({ app, page }) => {
  await openBigFile(app, 'emoji.txt', BIG, LINES);
  await expectLine(page, 0, `go ${FAMILY}🇯🇵 end`);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await state(page)).caret).toEqual({ line: 0, col: 3 });
  // Over the family, then over the flag: one press each.
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await state(page)).caret).toEqual({ line: 0, col: 3 + FAMILY.length });
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await state(page)).caret).toEqual({ line: 0, col: 3 + FAMILY.length + 4 });
});
