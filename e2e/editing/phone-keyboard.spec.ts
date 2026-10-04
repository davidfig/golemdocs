// A phone's keyboard sends input events (delete, line break, text) rather than key presses; the document and the large-text editor
// handle them the same way (client/src/ui/textInput.ts).

import { expect, test } from '../fixtures';
import { clickAt, expectLine, openBigFile, statusBarOn } from '../files/large-helpers';

test.beforeEach(({ page }) => statusBarOn(page));

const LINES = 150_000;
const BIG = Buffer.from(Array.from({ length: LINES }, (_, i) => `Line ${i + 1} the quick brown fox jumps over the lazy dog ${'.'.repeat(12)}`).join('\n') + '\n', 'utf8');

/** Fires an input event at the focused textarea, as a phone keyboard does. */
const inputEvent = (page: import('@playwright/test').Page, inputType: string, data?: string) =>
  page.evaluate(([type, text]) => {
    const target = document.activeElement as HTMLTextAreaElement;
    target.dispatchEvent(new InputEvent('beforeinput', { inputType: type!, data: text ?? null, cancelable: true, bubbles: true }));
  }, [inputType, data] as const);

test('in a document, a phone keyboard\'s delete and line break work', async ({ app, page }) => {
  await app.blank();
  await app.type('Hello wor');
  await inputEvent(page, 'insertText', 'ld');
  await inputEvent(page, 'deleteContentBackward');
  await inputEvent(page, 'insertParagraph');
  await inputEvent(page, 'insertText', 'Next');
  await expect.poll(() => app.text()).toBe('Hello worl\nNext');
});

test('in the large-text editor, the same events work', async ({ app, page }) => {
  await openBigFile(app, 'phone.txt', BIG, LINES);
  await clickAt(page, 0, 0);
  await inputEvent(page, 'insertText', 'ab');
  await inputEvent(page, 'deleteContentBackward');
  await inputEvent(page, 'insertParagraph');
  await expectLine(page, 0, 'a');
  await expectLine(page, 1, /^Line 1 the quick/);
});
