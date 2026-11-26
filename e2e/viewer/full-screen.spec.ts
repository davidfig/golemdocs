// The shared pages' Full Screen (the viewer's `fullScreen`, the app's ui/fullScreen.ts): everything but the document goes (Golem
// Docs' header, the bar, a folder's files, the status bar) and comes back on leaving. Where the browser refuses full screen (a frame
// not allowed to, here a stubbed refusal) the page hides its chrome all the same, with a button in the corner, and Esc leaves.

import { test, expect } from '../fixtures';
import { CLIENT_ORIGIN } from '../ports.ts';
import { folderProject, newPerson, signedOutContext } from '../collab/helpers';

const chrome = ['.wm-viewer-header', '.wm-viewer-tools', '.wm-folder-files', '.wm-footer'];

test('Full Screen leaves only the document, and leaving it brings the rest back', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  await owner.page.goto('/?doc=welcome');
  await owner.app.ready();
  const folderId = await folderProject(owner.page);
  const { token } = (await (await owner.page.request.put(`/api/folders/${folderId}/link`, { headers: { origin: CLIENT_ORIGIN } })).json()) as { token: string };

  const stranger = await signedOutContext(browser);
  const page = await stranger.newPage();
  await page.goto(`/view?pf=${token}`);
  await expect(page.getByRole('navigation', { name: 'Files' })).toBeVisible();
  const button = page.getByRole('toolbar').getByRole('button', { name: 'Full Screen' });

  // The browser's own full screen.
  await button.click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  for (const part of chrome) await expect(page.locator(part)).toBeHidden();
  await expect(page.locator('.wm-folder-doc canvas')).toBeVisible();
  await page.evaluate(() => document.exitFullscreen());
  for (const part of chrome) await expect(page.locator(part)).toBeVisible();

  // Refused by the browser: the page's own, with a button to leave, and Esc.
  await page.evaluate(() => {
    document.documentElement.requestFullscreen = () => Promise.reject(new Error('refused'));
  });
  await button.click();
  for (const part of chrome) await expect(page.locator(part)).toBeHidden();
  const leave = page.getByRole('button', { name: 'Leave Full Screen' });
  await expect(leave).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(leave).toHaveCount(0);
  for (const part of chrome) await expect(page.locator(part)).toBeVisible();
  await button.click();
  await leave.click();
  await expect(page.getByRole('banner')).toBeVisible();
  await owner.context.close();
  await stranger.close();
});
