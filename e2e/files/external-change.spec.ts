// A document's file changed outside the app while it is open (in the desktop app, a file in the vault folder): what changed is put
// into the open document in place, the caret and the view stay on the text they were on, and the new text is highlighted for a moment.
// The vault folder is only watched in the desktop app, so the change is handed to the page through its `refreshWith` hook.

import { expect, test } from './fixtures';
import { importFile, text } from './helpers';

type Hooks = {
  refreshWith: (source: { kind: string; name: string; bytes: ArrayBuffer }) => Promise<boolean>;
  selectionState: { at: { focus: [number, number] } | null; fading: boolean };
  camera: { y: number };
};

const refresh = (page: import('@playwright/test').Page, name: string, content: string) =>
  page.evaluate(({ name, content }) => (window as unknown as Hooks).refreshWith({ kind: 'md', name, bytes: new TextEncoder().encode(content).buffer as ArrayBuffer }), { name, content });
const focus = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as Hooks).selectionState.at?.focus ?? null);
const fading = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as Hooks).selectionState.fading);

test('a changed file is put in place: the caret stays on its text and the change is highlighted, then fades', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('Notes.md', '# Notes\n\nFirst point.\n\nSecond point, with the caret.\n'));
  await app.focus();
  await app.press('ControlOrMeta+End');
  await expect.poll(() => focus(page)).toEqual([2, 29]);

  expect(await refresh(page, 'Notes.md', '# Notes\n\nAn added paragraph.\n\nFirst point, edited.\n\nSecond point, with the caret.\n')).toBe(true);
  await expect.poll(() => app.text()).toContain('First point, edited.');
  expect(await app.text()).toContain('An added paragraph.');
  // The caret's paragraph is one further down now, at the same place in its text.
  await expect.poll(() => focus(page)).toEqual([3, 29]);
  await expect.poll(() => fading(page)).toBe(true);
  await expect.poll(() => fading(page), { timeout: 5000 }).toBe(false);
});

test('text added above the view leaves the view on what it showed', async ({ app, page }) => {
  const lines = Array.from({ length: 80 }, (_, i) => `Paragraph number ${i + 1}.`);
  await app.goto('?doc=welcome');
  await importFile(app, text('Long.md', lines.join('\n\n') + '\n'));
  await app.focus();
  await page.mouse.wheel(0, 1500);
  await app.settle();
  const before = await page.evaluate(() => (window as unknown as Hooks).camera.y);
  expect(before).toBeGreaterThan(100);

  const added = Array.from({ length: 10 }, (_, i) => `New paragraph ${i + 1}.`);
  expect(await refresh(page, 'Long.md', [...added, ...lines].join('\n\n') + '\n')).toBe(true);
  await expect.poll(() => app.text()).toContain('New paragraph 10.');
  // Ten paragraphs went in above: the view moved down with the text it was on, rather than the text sliding under it.
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).camera.y)).toBeGreaterThan(before + 100);
});
