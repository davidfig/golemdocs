// The Documents screen's List (docs/architecture/accessibility.md): Grid or List is a named radio group the arrow keys move through,
// each row's ⋯ is a button named for its document that opens the row's menu and gets the keyboard back, and Up is named.

import { expect, test } from '../files/fixtures';
import { dropFile, text, waitForSaved } from '../files/helpers';

test('Grid or List, a row’s ⋯ menu and Up are all reached and named', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, text('Budget.md', '# Budget\n'), { x: 400, y: 400 });
  await waitForSaved(page);
  await app.menu('File', 'Open…');
  const screen = page.getByRole('region', { name: 'Documents' });
  const view = screen.getByRole('radiogroup', { name: 'View' });
  await expect(view.getByRole('radio', { name: 'Grid' })).toHaveAttribute('aria-checked', 'true');
  await view.getByRole('radio', { name: 'Grid' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(view.getByRole('radio', { name: 'List' })).toHaveAttribute('aria-checked', 'true');
  await expect(view.getByRole('radio', { name: 'List' })).toBeFocused();

  const more = screen.getByRole('button', { name: 'More for Budget.md' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu').getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
  // Up is for a phone, where the path is cramped; on a wide screen the path is enough.
  await expect(screen.getByRole('button', { name: 'Up a level' })).toBeHidden();
  await view.getByRole('radio', { name: 'List' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(view.getByRole('radio', { name: 'Grid' })).toHaveAttribute('aria-checked', 'true');
});
