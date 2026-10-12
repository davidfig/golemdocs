// Reopening a document puts back where it was left (src/viewMemory.ts): the caret, the selection
// and the scroll position, kept in this browser.

import type { Page } from '@playwright/test';
import { test, expect, MOD, type App } from './fixtures';
import { blankWith } from './helpers';
import { resize } from '../shell/helpers';

const saved = (page: Page) => expect(page.locator('.wm-sync')).toHaveAttribute('data-local', 'saved', { timeout: 15_000 });

const cameraY = (page: Page) => page.evaluate(() => (window as unknown as { camera: { y: number } }).camera.y);

/** Reloads the page (leaving it remembers the view) and waits for the document to be back. */
async function reopen(app: App): Promise<void> {
  await app.page.reload();
  await app.ready();
  await app.settle();
}

test('a selection comes back with the caret at the same end, and the document is not changed by it', async ({ app, page }) => {
  await blankWith(app, 'alpha one', 'beta two', 'gamma three');
  await saved(page);
  await expect(page).toHaveURL(/\?doc=local%3A/);
  // From the start of the last line up to the start of the second: selected backwards, across paragraphs.
  await app.press('Home');
  await app.press('Shift+ArrowUp');
  await app.settle();
  const selected = await app.selectedText();
  expect(selected).toContain('beta two');
  await reopen(app);
  await expect.poll(() => app.selectedText()).toBe(selected);
  await saved(page);
  // The caret is at the start: Shift+Right takes the first character off rather than adding one.
  await app.focus();
  await app.press('Shift+ArrowRight');
  await app.settle();
  expect(await app.selectedText()).toBe(selected.slice(1));
});

test('the caret comes back where it was, and typing goes there', async ({ app, page }) => {
  await blankWith(app, 'alpha one', 'beta two');
  await saved(page);
  await app.press('Home');
  await app.press('ArrowRight', 3);
  await app.settle();
  await reopen(app);
  await app.type('X');
  await expect.poll(() => app.text()).toBe('alpha one\nbetXa two');
});

test('the selection is the same text after the window changes size in Flow view', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await app.menu('View', 'Flow');
  await blankWith(app, 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty. '.repeat(4));
  await saved(page);
  await app.press(`${MOD}+Home`);
  await app.press('ArrowRight', 140);
  await app.press('Shift+ArrowRight', 9);
  await app.settle();
  const selected = await app.selectedText();
  expect(selected).toHaveLength(9);
  // Narrower: the text wraps differently, so the selection is somewhere else on the screen.
  const size = page.viewportSize()!;
  await resize(page, Math.round(size.width * 0.6), size.height);
  await reopen(app);
  await expect.poll(() => app.selectedText()).toBe(selected);
});

test('the scroll position is kept when the keyboard moved it', async ({ app, page }) => {
  await app.blank();
  for (const word of ['one', 'two', 'three']) {
    await app.type(word);
    await app.press(`${MOD}+Enter`);
  }
  await app.type('four');
  await saved(page);
  await app.press(`${MOD}+End`);
  await app.settle();
  const y = await cameraY(page);
  expect(y).toBeGreaterThan(0);
  await reopen(app);
  await expect.poll(() => cameraY(page)).toBeCloseTo(y, 0);
  await app.type('!');
  await expect.poll(() => app.text()).toMatch(/four!$/);
});
