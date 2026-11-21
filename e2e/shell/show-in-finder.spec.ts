// Show in Finder (File Explorer, Files) in the desktop app, with a stand-in shell holding a small vault in memory: File › Show in
// Finder and the right-click menus of the Files pane and the Documents screen ask the shell to select the document's file, or the
// folder, in the vault. In a browser there is no vault and none of them is offered. docs/architecture/desktop.md.

import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { vaultShell } from './vaultShell';

const FILE = "Bob's notes/Plan, v2.md";

const revealed = (page: Page) => page.evaluate(() => window.__revealed);
const sidebar = (page: Page) => page.locator('.wm-files');

/** Starts the app with the vault synced (its note is a document now, in a folder of the account). */
async function start(page: Page, app: { goto(query?: string): Promise<void> }): Promise<void> {
  await vaultShell(page, { [FILE]: '# Plan\n\nIntro.\n' });
  await app.goto('?doc=welcome');
  await expect.poll(() => page.evaluate(() => '.golemdocs/state.json' in window.__vault), { timeout: 30_000 }).toBe(true);
}

test('File › Show in Finder selects the open document\'s file in the vault', async ({ page, app }) => {
  await start(page, app);
  await page.evaluate((file) => {
    window.__links.push(`golemdocs://open?file=${encodeURIComponent(file)}`);
    dispatchEvent(new Event('golem-link'));
  }, FILE);
  await expect.poll(() => app.text()).toContain('Intro.');
  await app.menu('File', 'Show in Finder');
  await expect.poll(() => revealed(page)).toEqual([FILE]);
});

test('the Files pane and the Documents screen show a document or a folder in Finder from their right-click menus', async ({ page, app }) => {
  await start(page, app);
  if (!(await sidebar(page).isVisible())) await app.menu('View', 'Files Sidebar');
  const folder = sidebar(page).locator('.wm-files-folder', { hasText: "Bob's notes" });
  await expect(folder).toHaveCount(1, { timeout: 30_000 });
  await folder.click({ button: 'right' });
  await expect(page.getByRole('menu').getByRole('menuitem').nth(1)).toHaveText('Show in Finder');
  await page.getByRole('menuitem', { name: 'Show in Finder' }).click();
  await expect.poll(() => revealed(page)).toEqual(["Bob's notes"]);

  if (!(await sidebar(page).locator('.wm-files-file', { hasText: 'Plan, v2' }).isVisible())) await folder.click();
  await sidebar(page).locator('.wm-files-file', { hasText: 'Plan, v2' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show in Finder' }).click();
  await expect.poll(() => revealed(page)).toEqual(["Bob's notes", FILE]);

  await app.menu('File', 'Open…');
  const screen = page.locator('.wm-dashboard');
  await screen.locator('article.wm-folder').filter({ hasText: "Bob's notes" }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show in Finder' }).click();
  await expect.poll(() => revealed(page)).toEqual(["Bob's notes", FILE, "Bob's notes"]);
});

test('in a browser there is no Show in Finder', async ({ page, app }) => {
  await app.goto('?doc=welcome');
  await app.menubar.getByRole('menuitem', { name: /^File$/ }).click();
  await expect(page.getByRole('menu').getByRole('menuitem', { name: 'Show in Finder' })).toHaveCount(0);
});
