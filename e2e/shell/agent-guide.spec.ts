// What ai apps working in the vault are told (client/src/desktop/agentGuide.ts, docs/architecture/desktop.md): the app writes its
// guide to `.golemdocs/AGENTS.md` once the folder syncs, and File › Vault Folder offers to point the person's own AGENTS.md or
// CLAUDE.md at it, or to make an AGENTS.md when there is none. A stand-in shell holds the vault in memory.

import type { Page } from '@playwright/test';
import { expect, test, type App } from '../fixtures';
import { vaultShell } from './vaultShell';

const GUIDE = '.golemdocs/AGENTS.md';

const fileText = (page: Page, path: string) => page.evaluate((p) => (p in window.__vault ? new TextDecoder().decode(Uint8Array.from(atob(window.__vault[p]), (c) => c.charCodeAt(0))) : null), path);

async function start(page: Page, app: App, files: Record<string, string>): Promise<void> {
  await vaultShell(page, files);
  await app.goto('?doc=welcome');
  await expect.poll(() => fileText(page, GUIDE), { timeout: 30_000 }).toContain('This folder is a Golem Docs vault');
}

async function openVaultDialog(app: App) {
  await app.menu('File', 'Vault Folder');
  const dialog = app.page.getByRole('dialog', { name: 'Vault Folder' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Instructions for ai apps in the vault', () => {
  test('the guide is written once the folder syncs, and a folder with no AGENTS.md gets one with the line', { tag: '@heavy' }, async ({ page, app }) => {
    await start(page, app, { 'Notes.md': '# Notes\n' });
    expect(await fileText(page, 'AGENTS.md')).toBeNull();

    const dialog = await openVaultDialog(app);
    await expect(dialog.getByText(/this folder has none/)).toBeVisible();
    const create = dialog.getByRole('button', { name: 'Create AGENTS.md' });
    await create.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => fileText(page, 'AGENTS.md')).toContain(GUIDE);
    expect(await fileText(page, 'AGENTS.md')).toMatch(/^# Instructions for ai apps\n\n/);
    await expect(dialog.getByText('ai apps that work in this folder are told how Golem Docs keeps it.')).toBeVisible();
    await expect(create).toBeHidden();
  });

  test('the person’s own instruction files get the line at the end, and nothing else in them changes', async ({ page, app }) => {
    const mine = '# My rules\n\n- Keep my voice.\n';
    await start(page, app, { 'AGENTS.md': mine, 'CLAUDE.md': '@AGENTS.md\n' });
    const dialog = await openVaultDialog(app);
    await expect(dialog.getByText(/from AGENTS\.md and CLAUDE\.md at the top/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Add the Line' }).click();
    await expect.poll(() => fileText(page, 'CLAUDE.md')).toContain(GUIDE);
    const agents = (await fileText(page, 'AGENTS.md'))!;
    expect(agents.startsWith(`${mine}\n`)).toBe(true);
    expect(agents.split(GUIDE).length).toBe(2);
    await expect(dialog.getByRole('button', { name: 'Add the Line' })).toBeHidden();
  });
});
