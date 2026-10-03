// File > Import Folder, the Import folder button on the Documents screen, and the tip in the Files sidebar.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { status } from './helpers';

/** A folder on disk: `Project/top.txt`, `Project/Docs/plan.md`, `Project/Docs/Deep/q1.txt`. */
function makeFolder(): { root: string; folder: string } {
  const root = mkdtempSync(join(tmpdir(), 'golem-folder-'));
  const folder = join(root, 'Project');
  mkdirSync(join(folder, 'Docs', 'Deep'), { recursive: true });
  writeFileSync(join(folder, 'top.txt'), 'at the top');
  writeFileSync(join(folder, 'Docs', 'plan.md'), '# plan');
  writeFileSync(join(folder, 'Docs', 'Deep', 'q1.txt'), 'quarter one');
  return { root, folder };
}

test('File > Import Folder imports a folder with its subfolders', async ({ app, page }) => {
  const { root, folder } = makeFolder();
  try {
    await app.goto('?doc=welcome');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.menu('File', 'Import Folder…')]);
    await chooser.setFiles(folder);
    await expect.poll(() => status(page)).toBe('Imported documents: 3');
    await app.menu('View', 'Files Sidebar');
    await expect(page.locator('.wm-files').getByText('Project', { exact: true })).toBeVisible();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the Documents screen has an Import folder button', async ({ app, page }) => {
  const { root, folder } = makeFolder();
  try {
    await app.goto('?doc=welcome');
    await app.menu('File', 'Open…');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.wm-dashboard').getByRole('button', { name: 'Import folder' }).click()]);
    await chooser.setFiles(folder);
    await expect.poll(() => status(page)).toBe('Imported documents: 3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the Files sidebar tip explains dropping, and stays dismissed', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await app.menu('View', 'Files Sidebar');
  const tip = page.locator('.wm-files-tip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Drop files or folders here');
  await tip.getByRole('button', { name: 'Dismiss tip' }).click();
  await expect(tip).toBeHidden();
  await page.reload();
  await app.ready();
  await expect(page.locator('.wm-files')).toBeVisible();
  await expect(tip).toBeHidden();
});

test('the Files sidebar right-click menu has Import folder', async ({ app, page }) => {
  const { root, folder } = makeFolder();
  try {
    await app.goto('?doc=welcome');
    await app.menu('View', 'Files Sidebar');
    await page.locator('.wm-files-tree').click({ button: 'right', position: { x: 100, y: 300 } });
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Import folder' }).click()]);
    await chooser.setFiles(folder);
    await expect.poll(() => status(page)).toBe('Imported documents: 3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
