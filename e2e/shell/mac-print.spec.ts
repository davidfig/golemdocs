// Printing in the Mac app (a stand-in shell here): its web view ignores print() and opens no tabs, so the PDF opens in Preview through
// `print_open_pdf`. A shell older than the page lacks that command, and the PDF is saved instead. docs/architecture/desktop.md.

import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';

declare global {
  interface Window {
    __printed: { name: string; head: string }[];
  }
}

async function macShell(page: Page, hasCommand: boolean): Promise<void> {
  await page.addInitScript((has) => {
    window.__printed = [];
    localStorage.setItem('word.vaultAsked', '1'); // no first-launch question about the vault folder
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    const invoke = async (command: string, args?: { name: string; data: string }) => {
      if (command === 'vault_root') return null;
      if (command !== 'print_open_pdf') return null;
      if (!has) throw 'Command print_open_pdf not found';
      window.__printed.push({ name: args!.name, head: atob(args!.data).slice(0, 5) });
      return null;
    };
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke } };
  }, hasCommand);
}

for (const item of ['Print…', 'Print Preview']) {
  test(`${item} opens the PDF in Preview, with no frame or new tab`, async ({ app, page }) => {
    await macShell(page, true);
    await app.goto('?doc=welcome');
    await app.menu('File', item);
    await expect.poll(() => page.evaluate(() => window.__printed)).toEqual([{ name: 'Welcome to Golem Docs.pdf', head: '%PDF-' }]);
    await expect.poll(() => page.evaluate(() => (window as unknown as { status: string }).status)).toContain('Opened in Preview');
    await expect(page.locator('iframe[src^="blob:"]')).toHaveCount(0);
    expect(page.context().pages()).toHaveLength(1);
  });
}

test('in a shell without the command, Print saves the PDF and says so', async ({ app, page }) => {
  await macShell(page, false);
  await app.goto('?doc=welcome');
  const file = await app.download(() => app.menu('File', 'Print…'));
  expect(file.name).toBe('Welcome to Golem Docs.pdf');
  expect(file.bytes.subarray(0, 5).toString()).toBe('%PDF-');
  await expect.poll(() => page.evaluate(() => (window as unknown as { status: string }).status)).toContain('Saved “Welcome to Golem Docs.pdf” to Downloads');
});
