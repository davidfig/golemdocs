// Trash from the keyboard (docs/architecture/accessibility.md): the Files sidebar's Trash entry is a tree item like a folder, a
// deleted document under it opens with Enter, and the read-only view of it is a named dialog that Escape closes, giving the keyboard
// back to the row it was opened from.

import { App, expect, test } from '../fixtures';
import { waitForSaved } from '../files/helpers';
import { signedOutContext } from '../collab/helpers';

test('a deleted document is reached, opened and closed again with the keyboard alone', async ({ browser }) => {
  const context = await signedOutContext(browser);
  const page = await context.newPage();
  const app = new App(page);
  await app.blank();
  await app.type('read me first');
  await waitForSaved(page);
  const sidebar = page.locator('.wm-files');
  if (!(await sidebar.isVisible())) await app.menu('View', 'Files Sidebar');
  const tree = sidebar.getByRole('tree', { name: 'Files' });
  const doc = tree.getByRole('treeitem', { name: /Document1/ });
  await doc.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Delete' }).press('Enter');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).press('Enter');

  const trash = tree.getByRole('treeitem', { name: /Trash$/ });
  await trash.focus();
  await page.keyboard.press('ArrowRight');
  await expect(trash).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown');
  const row = tree.getByRole('treeitem', { name: /Document1/ });
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute('aria-level', '2');
  await page.keyboard.press('Enter');

  const preview = page.getByRole('dialog', { name: /Document1/ });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Restore' })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Delete Forever' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(row).toBeFocused();
  await context.close();
});
