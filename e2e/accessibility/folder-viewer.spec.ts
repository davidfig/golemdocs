// A shared folder's page (/view?pf=…, src/viewer/folderPage.ts) from the keyboard and with a screen reader: the files are a
// navigation landmark named Files, of ordinary links and disclosure sections, the file shown is marked current, the Files button says
// whether the tree is open, F6 moves between the tree and the document, and a link that goes outside the folder is said. Golem Docs'
// header is the page's banner: its links and buttons have names, and its link home comes first.

import { test, expect } from '../fixtures';
import { CLIENT_ORIGIN } from '../ports.ts';
import { clickTopLink, folderProject, newPerson, signedOutContext } from '../collab/helpers';

test('the folder page’s tree is a named landmark worked from the keyboard, and F6 moves between it and the document', { tag: '@heavy' }, async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  await owner.page.goto('/?doc=welcome');
  await owner.app.ready();
  const folderId = await folderProject(owner.page);
  const { token } = (await (await owner.page.request.put(`/api/folders/${folderId}/link`, { headers: { origin: CLIENT_ORIGIN } })).json()) as { token: string };

  const stranger = await signedOutContext(browser);
  const page = await stranger.newPage();
  await page.goto(`/view?pf=${token}`);
  const tree = page.getByRole('navigation', { name: 'Files' });
  await expect(tree.getByRole('link', { name: 'README.md' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('main', { name: 'README.md (view only)' })).toHaveCount(1);
  const toggle = page.getByRole('button', { name: 'Files' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // The header: a banner with Golem Docs' link first, the file as the page's heading, and named buttons.
  const banner = page.getByRole('banner');
  await expect(banner.getByRole('heading', { level: 1 })).toContainText('README.md');
  await expect(banner.getByRole('button', { name: 'Download All' })).toBeVisible();
  await expect(banner.getByRole('link', { name: 'Try Golem Docs' })).toBeVisible();
  await expect(page.getByRole('toolbar').getByRole('button', { name: 'Print' })).toBeVisible();
  // Golem Docs' link comes first, before the Files button.
  await toggle.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(banner.getByRole('link', { name: 'Golem Docs', exact: true })).toBeFocused();

  // F6 from the document reaches the file shown in the tree; F6 again goes back to the document.
  await page.locator('.wm-folder-doc canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('F6');
  await expect(tree.getByRole('link', { name: 'README.md' })).toBeFocused();
  await page.keyboard.press('F6');
  await expect(page.locator('.wm-folder-doc .wm-viewer-input')).toBeFocused();

  // A folder closes and opens from the keyboard, and Enter on a file opens it.
  await page.keyboard.press('F6');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  const notes = tree.locator('summary', { hasText: 'Notes' });
  await expect(notes).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tree.getByRole('link', { name: 'Ideas.md' })).toBeHidden();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(tree.getByRole('link', { name: 'Ideas.md' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveTitle('Ideas.md (view only) · Project');
  await expect(tree.getByRole('link', { name: 'Ideas.md' })).toHaveAttribute('aria-current', 'page');

  // The tree closes and opens with its button, which says so.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(tree).toBeHidden();
  await toggle.click();
  await expect(tree).toBeVisible();

  // A link out of the folder is said in a status line.
  await clickTopLink(page);
  await expect(page.getByRole('status').filter({ hasText: 'That link goes to a document outside this shared folder.' })).toHaveCount(1);
  await owner.context.close();
  await stranger.close();
});
