// Trash from the keyboard (docs/architecture/accessibility.md): the Files sidebar's Trash button opens a tree named Trash in the
// Files tree's place, a deleted document in it opens with Enter, the read-only view of it is a named dialog that Escape closes
// (giving the keyboard back to its row), and Escape again goes back to the Files tree.

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

  const trash = sidebar.getByRole('button', { name: 'Trash', exact: true });
  await trash.focus();
  await page.keyboard.press('Enter');
  const row = sidebar.getByRole('tree', { name: 'Trash' }).getByRole('treeitem', { name: /Document1/ });
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute('aria-level', '1');
  await page.keyboard.press('Enter');

  const preview = page.getByRole('dialog', { name: /Document1/ });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Restore' })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Delete Forever' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(row).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tree).toBeVisible();
  await expect(trash).toBeFocused();
  await context.close();
});
