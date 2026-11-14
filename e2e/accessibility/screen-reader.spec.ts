// Screen Reader Mode and getting around from the keyboard (docs/architecture/accessibility.md): the hidden textarea
// mirrors the text near the caret, the reading layer describes the pages in view as HTML, and F6 and the arrow keys reach
// the toolbars.

import { MOD, expect, test, type App } from '../fixtures';
import { importFile } from '../files/helpers';

/** Turns Screen Reader Mode on from the Tools menu, and checks it is announced. */
async function screenReaderOn(app: App): Promise<void> {
  await app.menu('Tools', 'Screen Reader Mode');
  await expect(app.page.locator('.wm-sr-only[aria-live]', { hasText: 'Screen Reader Mode on' })).toHaveCount(1);
}

const mirror = (app: App) => app.editor.evaluate((el: HTMLTextAreaElement) => ({ value: el.value, start: el.selectionStart, end: el.selectionEnd }));

test.describe('Screen Reader Mode', () => {
  test('the textarea holds the paragraph with the caret where ours is, and follows a selection', async ({ app }) => {
    await app.blank();
    await screenReaderOn(app);
    await app.type('Hello world');
    await expect.poll(() => mirror(app)).toEqual({ value: 'Hello world', start: 11, end: 11 });
    await app.press('ArrowLeft', 5);
    await expect.poll(() => mirror(app)).toEqual({ value: 'Hello world', start: 6, end: 6 });
    await app.press('Shift+ArrowRight', 5);
    await expect.poll(() => mirror(app)).toEqual({ value: 'Hello world', start: 6, end: 11 });
  });

  test('without it the textarea stays empty and tells how to turn it on', async ({ app }) => {
    await app.blank();
    await app.type('Hello');
    await app.settle();
    expect((await mirror(app)).value).toBe('');
    await expect(app.editor).toHaveAttribute('aria-description', /Screen Reader Mode/);
    await expect(app.page.locator('.wm-reading-page')).toHaveCount(0);
  });

  test('the reading layer has the headings, and choosing one puts the caret there', async ({ app }) => {
    await app.goto('?doc=welcome');
    await screenReaderOn(app);
    const layer = app.page.locator('.wm-reading');
    await expect(layer.locator('h1').first()).toHaveText('Welcome to Golem Docs');
    await expect(layer.locator('h2').first()).toHaveText('What it does');
    await expect(layer.locator('.wm-reading-page li').first()).toContainText('Open almost anything.');
    const link = layer.getByRole('navigation', { name: 'Headings' }).getByRole('link', { name: 'What it does' });
    await expect(link).toHaveCount(1);
    await link.evaluate((el: HTMLElement) => el.click());
    await expect.poll(() => mirror(app).then((m) => m.value)).toBe('What it does');
    await expect(app.editor).toBeFocused();
  });

  test('Next and Previous Heading move the caret between headings, and say when there are no more', async ({ app }) => {
    await app.goto('?doc=welcome');
    await screenReaderOn(app);
    await app.focus();
    await app.press(`${MOD}+Home`);
    await app.press(`${MOD}+Alt+PageDown`);
    await expect.poll(() => mirror(app).then((m) => m.value)).toBe('What it does');
    await app.press(`${MOD}+Alt+PageUp`);
    // The heading starts with an icon, a picture: U+FFFC keeps the caret's place in the text.
    await expect.poll(() => mirror(app).then((m) => m.value)).toMatch(/^\uFFFC? ?Welcome to Golem Docs$/);
    await app.press(`${MOD}+Alt+PageUp`);
    await expect(app.page.locator('.wm-toast')).toHaveText('No more headings that way.');
  });

  test('in a plain text file the textarea holds the caret’s line', async ({ app }) => {
    await app.blank();
    await importFile(app, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('first line\nsecond line\nthird line\n') });
    await screenReaderOn(app);
    const input = app.page.locator('.wm-large-input');
    await app.focus();
    await app.press(`${MOD}+Home`);
    await app.press('ArrowDown');
    await expect.poll(() => input.evaluate((el: HTMLTextAreaElement) => [el.value, el.selectionStart]))
      .toEqual(['second line', 0]);
  });
});

test.describe('Keyboard regions', () => {
  test('F6 goes from the document to the menu bar and on to a toolbar, whose buttons the arrow keys move between', async ({ app }) => {
    await app.blank();
    await app.press('F6');
    // From the document forward: past the side panels to the menu bar.
    await expect.poll(() => app.page.evaluate(() => !!document.activeElement?.closest('[role="menubar"]'))).toBe(true);
    await app.press('F6');
    const toolbar = app.page.locator('[role="toolbar"]:focus-within');
    await expect(toolbar).toHaveCount(1);
    const first = await app.page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent);
    await app.press('ArrowRight');
    const second = await app.page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent);
    expect(second).not.toBe(first);
    await expect(toolbar).toHaveCount(1);
    await app.press('Escape');
    await expect(app.editor).toBeFocused();
  });
});
