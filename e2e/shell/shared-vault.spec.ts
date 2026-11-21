// Copies of folders shared with this account in the desktop vault (client/src/desktop/vaultShared.ts, docs/folder-sharing.md): a
// folder shared to edit is copied under Shared/<owner>/<folder>/, an edit made there reaches the owner's document, and
// "In my vault…" on its card leaves a folder out (an index of it takes its place) or removes the copy. A stand-in shell holds the vault in memory.

import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { CLIENT_ORIGIN } from '../ports.ts';
import { folderProject, newPerson } from '../collab/helpers';
import { vaultShell } from './vaultShell';

const fileText = (page: Page, path: string) => page.evaluate((p) => (p in window.__vault ? new TextDecoder().decode(Uint8Array.from(atob(window.__vault[p]), (c) => c.charCodeAt(0))) : null), path);
const vaultPaths = (page: Page) => page.evaluate(() => Object.keys(window.__vault).filter((p) => !p.startsWith('.')).sort());

test('a folder shared to edit is kept in the vault under Shared, edits there reach the owner, and the copy can be turned off', async ({ page, app, browser }) => {
  const owner = await newPerson(browser, 'owner');
  await owner.page.goto('/?doc=welcome');
  await owner.app.ready();
  const folderId = await folderProject(owner.page);
  const email = await vaultShell(page, { 'Mine.md': '# Mine\n' });
  const shared = await owner.page.request.put(`/api/folders/${folderId}/shares`, { data: { email, role: 'editor' }, headers: { origin: CLIENT_ORIGIN } });
  expect(shared.ok(), await shared.text()).toBe(true);

  await app.goto('?doc=welcome');
  const copy = `Shared/${owner.name}/Project`;
  await expect.poll(() => vaultPaths(page), { timeout: 30_000 }).toEqual(['Mine.md', `${copy}/Notes/Ideas.md`, `${copy}/README.md`]);
  // The label is kept in the account, so another computer puts the copy in the same place.
  const listed = (await (await page.request.get('/api/shared-folders')).json()) as { localName: string | null }[];
  expect(listed[0]!.localName).toBe(`${owner.name}/Project`);

  // An edit in the copy reaches the owner's document (kept as a new save of it); the person's own documents never get the shared files.
  const ideas = async () => ((await (await owner.page.request.get('/api/documents')).json()) as { name: string; updatedAt: number }[]).find((d) => d.name === 'Ideas.md')!.updatedAt;
  const before = await ideas();
  await page.evaluate((path) => (window.__vault[path] = btoa('# Ideas, edited\n')), `${copy}/Notes/Ideas.md`);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(ideas, { timeout: 30_000 }).toBeGreaterThan(before);
  const mine = (await (await page.request.get('/api/documents')).json()) as { name: string }[];
  expect(mine.map((d) => d.name)).toEqual(['Mine.md']);

  // "In my vault…" on the folder's card: Notes left out. Its files go, an index of them takes its place, and the account keeps them.
  await app.menu('File', 'Open…');
  const card = page.locator('.wm-dashboard article.wm-folder').filter({ hasText: 'Project' });
  const choose = async () => {
    await card.hover();
    await card.getByRole('button', { name: 'Choose what your vault keeps of Project' }).click();
    return page.getByRole('dialog', { name: 'In My Vault' });
  };
  let dialog = await choose();
  const keep = dialog.getByRole('checkbox', { name: 'Keep a copy of Project in my vault' });
  const notes = dialog.getByRole('list', { name: 'Folders to keep' }).getByRole('checkbox', { name: 'Notes' });
  await expect(keep).toBeChecked();
  await expect(notes).toBeChecked();
  await notes.uncheck();
  await dialog.getByRole('button', { name: 'Save' }).click();
  const index = `${copy}/Notes (not in vault).md`;
  await expect.poll(() => vaultPaths(page), { timeout: 30_000 }).toEqual(['Mine.md', index, `${copy}/README.md`]);
  expect(await fileText(page, index)).toContain('- `Ideas.md`');
  expect((await (await owner.page.request.get('/api/documents')).json()).map((d: { name: string }) => d.name)).toContain('Ideas.md');

  // The copy turned off: it goes, the share stays. With it off, no folder can be picked.
  dialog = await choose();
  await expect(notes).not.toBeChecked();
  await keep.uncheck();
  await expect(notes).toBeDisabled();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => vaultPaths(page), { timeout: 30_000 }).toEqual(['Mine.md']);
  expect(await fileText(page, 'Mine.md')).toBe('# Mine\n');
  expect(((await (await page.request.get('/api/shared-folders')).json()) as unknown[]).length).toBe(1);
  await owner.context.close();
});
