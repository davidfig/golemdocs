// View > Files Sidebar: the documents as a tree beside the editor.

import { expect, test } from './fixtures';
import { dropFileOn, dropFilesOn, importFile, status, text, waitForOpen, waitForSaved } from './helpers';

const panel = (page: import('@playwright/test').Page) => page.locator('.wm-files');
const row = (page: import('@playwright/test').Page, name: string) => panel(page).locator('.wm-files-file', { hasText: name });

test('it is closed until chosen, lists the documents, opens one on a click, and the choice is kept', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await expect(panel(page)).toBeHidden();
  for (const file of [text('alpha.txt', 'the first'), text('beta.md', '# second')]) {
    await importFile(app, file);
    await waitForSaved(page, file.name);
  }

  await app.menu('View', 'Files Sidebar');
  await expect(panel(page)).toBeVisible();
  await expect(row(page, 'alpha')).toHaveCount(1);
  await expect(row(page, 'beta')).toHaveCount(1);
  await expect(row(page, 'beta')).toHaveClass(/wm-files-current/);

  await row(page, 'alpha').click();
  await expect(row(page, 'alpha')).toHaveClass(/wm-files-current/);
  await expect.poll(() => app.text()).toContain('the first');

  await page.reload();
  await app.ready();
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('button', { name: 'Close' }).click();
  await expect(panel(page)).toBeHidden();
});

test('dragging its edge resizes it, and the width is kept', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await app.menu('View', 'Files Sidebar');
  const width = async () => (await panel(page).boundingBox())!.width;
  expect(await width()).toBe(200);
  const edge = (await panel(page).getByRole('separator').boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 100);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 80, edge.y + 100, { steps: 4 });
  await page.mouse.up();
  expect(await width()).toBe(280);
  await page.reload();
  await app.ready();
  expect(await width()).toBe(280);
});

test('right click makes a folder, renames it, and deletes it with what is in it', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  const file = text('inside.txt', 'kept');
  await importFile(app, file);
  await waitForSaved(page, file.name);
  await app.menu('View', 'Files Sidebar');

  await panel(page).locator('.wm-files-tree').click({ button: 'right', position: { x: 100, y: 300 } });
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  await page.locator('.wm-files-rename').fill('Notes');
  await page.keyboard.press('Enter');
  const folder = panel(page).locator('.wm-files-folder', { hasText: 'Notes' });
  await expect(folder).toHaveCount(1);

  await row(page, 'inside').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move…' }).click();
  await page.locator('.wm-move-choice', { hasText: 'Notes' }).click();
  // The folder a document is moved into opens, so it shows there without clicking the folder.
  await expect(row(page, 'inside')).toHaveCount(1);

  await folder.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete folder' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.locator('.wm-delete-list li')).toHaveText(['Notes/', 'Notes/inside.txt']);
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(folder).toHaveCount(0);
  await expect(row(page, 'inside')).toHaveCount(0);
});

test('a file dropped from the computer goes in the folder it is dropped on, or the one of the document it is dropped on', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await app.menu('View', 'Files Sidebar');
  await panel(page).locator('.wm-files-tree').click({ button: 'right', position: { x: 100, y: 300 } });
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  await page.locator('.wm-files-rename').fill('Notes');
  await page.keyboard.press('Enter');
  const folder = panel(page).locator('.wm-files-folder', { hasText: 'Notes' });
  await expect(folder).toHaveCount(1);

  await dropFileOn(folder, text('first.txt', 'one'));
  await waitForOpen(app, 'first.txt');
  expect(await app.text()).toBe('one');
  await waitForSaved(page, 'first.txt');
  // The folder opens to show it, one level in.
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'first')).toHaveAttribute('aria-level', '2');

  await dropFileOn(row(page, 'first'), text('second.txt', 'two'));
  await waitForOpen(app, 'second.txt');
  await waitForSaved(page, 'second.txt');
  await expect(row(page, 'second')).toHaveAttribute('aria-level', '2');

  // Below the rows: the top level.
  await dropFileOn(panel(page).locator('.wm-files-tree'), text('third.txt', 'three'));
  await waitForOpen(app, 'third.txt');
  await waitForSaved(page, 'third.txt');
  await expect(row(page, 'third')).toHaveAttribute('aria-level', '1');
});

test('several files dropped on a folder together are imported into it, without opening any', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await app.menu('View', 'Files Sidebar');
  await panel(page).locator('.wm-files-tree').click({ button: 'right', position: { x: 100, y: 300 } });
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  await page.locator('.wm-files-rename').fill('Inbox');
  await page.keyboard.press('Enter');
  const folder = panel(page).locator('.wm-files-folder', { hasText: 'Inbox' });
  await expect(folder).toHaveCount(1);

  await dropFilesOn(folder, [text('one.txt', '1'), text('two.md', '# 2'), text('tool.exe', 'x')]);
  await expect.poll(() => status(page)).toContain('Imported documents: 2');
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'one')).toHaveAttribute('aria-level', '2');
  await expect(row(page, 'two')).toHaveAttribute('aria-level', '2');
  expect(await app.page.title()).toMatch(/^Welcome/);
});

test('one row of the tree is in the tab order, it follows the focus, and Left goes to the folder a row is in', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await app.menu('View', 'Files Sidebar');
  await panel(page).locator('.wm-files-tree').click({ button: 'right', position: { x: 100, y: 300 } });
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  await page.locator('.wm-files-rename').fill('Box');
  await page.keyboard.press('Enter');
  const folder = panel(page).locator('.wm-files-folder', { hasText: 'Box' });
  await dropFileOn(folder, text('inside.txt', 'in'));
  await waitForOpen(app, 'inside.txt');
  await waitForSaved(page, 'inside.txt');

  // One row at a time is in the tab order (the last one focused), and it moves with the focus.
  await expect(panel(page).locator('.wm-files-row[tabindex="0"]')).toHaveCount(1);
  await row(page, 'inside').focus();
  await expect(row(page, 'inside')).toHaveAttribute('tabindex', '0');
  // Left from inside a folder goes to the folder.
  await page.keyboard.press('ArrowLeft');
  await expect(folder).toBeFocused();
  await expect(folder).toHaveAttribute('tabindex', '0');
  await expect(row(page, 'inside')).toHaveAttribute('tabindex', '-1');
});
