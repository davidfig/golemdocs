// Insert ▸ Horizontal Line and Code Block: available in formats that have them, and written out as such.

import { expect, test } from '../fixtures';
import { blankWith, convertTo } from '../files/helpers';

test('Insert ▸ Horizontal Line and Code Block are for formats that have them', async ({ app }) => {
  await blankWith(app, 'Word text');
  await app.menubar.getByRole('menuitem', { name: /^Insert$/ }).click();
  // What the format can't express isn't offered at all.
  await expect(app.page.getByRole('menu').getByRole('menuitem', { name: /^Horizontal Line/ })).toBeVisible();
  await expect(app.page.getByRole('menu').getByRole('menuitem', { name: /^Code Block/ })).toHaveCount(0);
  await app.page.keyboard.press('Escape');
  await convertTo(app, 'Markdown (.md)', 'Markdown');
  await app.menubar.getByRole('menuitem', { name: /^Insert$/ }).click();
  await expect(app.page.getByRole('menu').getByRole('menuitem', { name: /^Code Block/ })).toHaveAttribute('aria-disabled', 'false');
  await expect(app.page.getByRole('menu').getByRole('menuitem', { name: /^Horizontal Line/ })).toHaveAttribute('aria-disabled', 'false');
});

test('a horizontal line goes after the text before the caret, and a code block is Markdown fences', async ({ app }) => {
  await blankWith(app, 'Intro', 'print(1)');
  await convertTo(app, 'Markdown (.md)', 'Markdown');
  await app.focus();
  // Caret at the end of the last paragraph: make it code, then add a line under "Intro".
  await app.press('ControlOrMeta+End');
  await app.menu('Insert', 'Code Block');
  await app.press('ControlOrMeta+Home');
  await app.press('End');
  await app.menu('Insert', 'Horizontal Line');
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.text.trim()).toBe('Intro\n\n---\n\n```\nprint(1)\n```');
  // Choosing Code Block again on code makes it plain text.
  await app.press('ControlOrMeta+End');
  await app.menu('Insert', 'Code Block');
  const again = await app.download(() => app.menu('File', 'Download'));
  expect(again.text.trim()).toBe('Intro\n\n---\n\nprint(1)');
});
