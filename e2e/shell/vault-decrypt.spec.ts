// Decrypting an encrypted folder into the vault folder for a session (docs/encrypted-folders.md), with a stand-in shell holding a small
// vault in memory: offered only on an unlocked encrypted folder in the desktop app, refused for a vault in a synced folder; its files are
// written readable for ai and other programs, what they change reaches the account encrypted, and locking takes the files out again.

import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { cloudDocs, newPerson } from '../collab/helpers';
import { vaultShell } from './vaultShell';

const vaultText = (page: Page, path: string) => page.evaluate((p) => (p in window.__vault ? new TextDecoder().decode(Uint8Array.from(atob(window.__vault[p]), (c) => c.charCodeAt(0))) : null), path);
const writeVault = (page: Page, path: string, text: string) =>
  page.evaluate(([p, t]) => void (window.__vault[p] = btoa(String.fromCharCode(...new TextEncoder().encode(t)))), [path, text] as const);
const vaultPaths = (page: Page) => page.evaluate(() => Object.keys(window.__vault).filter((p) => !p.startsWith('.')).sort());
const sidebar = (page: Page) => page.locator('.wm-files');

/** Encrypts the folder `name` from its menu in the Files pane, setting up the key. */
async function encryptFolder(page: Page, name: string): Promise<void> {
  await sidebar(page).locator('.wm-files-folder', { hasText: name }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Encrypt folder…' }).click();
  await page.getByRole('dialog', { name: `Encrypt “${name}”?` }).getByRole('button', { name: 'Encrypt' }).click();
  const setup = page.getByRole('dialog', { name: 'Your Encryption Key' });
  const key = (await setup.locator('.wm-encryption-key').textContent())!;
  await setup.getByLabel('Paste the key again to confirm you saved it').fill(key);
  await setup.getByRole('button', { name: 'I saved it' }).click();
  await expect(setup).toHaveCount(0);
  // Done once it shows with its padlock (open, while unlocked).
  await expect(sidebar(page).locator('.wm-files-folder', { hasText: name }).locator('.wm-files-lock')).toHaveCount(1, { timeout: 30_000 });
}

test('an encrypted folder decrypted into the vault: readable there, changes reach the account encrypted, and Lock takes it out', { tag: '@heavy' }, async ({ page, app }) => {
  await vaultShell(page, { 'Taxes/Return.md': '# Return\n\nThe secret number is 42.\n' });
  await app.goto('?doc=welcome');
  if (!(await sidebar(page).isVisible())) await app.menu('View', 'Files Sidebar');
  await expect(sidebar(page).locator('.wm-files-folder', { hasText: 'Taxes' })).toHaveCount(1, { timeout: 30_000 });

  // Encrypted, the folder leaves the vault: its file goes, and a note stands in for it.
  await encryptFolder(page, 'Taxes');
  await expect.poll(() => vaultPaths(page), { timeout: 30_000 }).toEqual(['Taxes (encrypted).md']);

  // Decrypt into vault folder…: the risks are said first; then the file is back, readable, and the note is gone.
  await sidebar(page).locator('.wm-files-folder', { hasText: 'Taxes' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Decrypt into vault folder…' }).click();
  const ask = page.getByRole('dialog', { name: 'Decrypt “Taxes” into your vault folder?' });
  await expect(ask.getByRole('listitem')).toHaveCount(3);
  await ask.getByRole('button', { name: 'Decrypt into vault folder' }).click();
  await expect.poll(() => vaultText(page, 'Taxes/Return.md'), { timeout: 30_000 }).toContain('The secret number is 42.');
  await expect.poll(() => vaultPaths(page)).toEqual(['Taxes/Return.md']);

  // An agent edits the file and adds one: the account gets both, encrypted.
  await writeVault(page, 'Taxes/Return.md', '# Return\n\nThe secret number is 43, an agent says.\n');
  await writeVault(page, 'Taxes/Notes.md', '# Notes\n\nWritten by an agent.\n');
  await expect.poll(async () => (await cloudDocs(page)).length, { timeout: 60_000 }).toBe(2);
  for (const doc of await cloudDocs(page)) {
    expect(doc.name.startsWith('gde1.')).toBe(true);
    const file = Buffer.from(await (await page.request.get(`/api/documents/${doc.id}`)).body());
    expect(file.subarray(0, 4).toString()).toBe('GDE1');
    expect(file.includes(Buffer.from('agent'))).toBe(false);
  }
  // And it opens in the app with the agent's change.
  await sidebar(page).locator('.wm-files-folder', { hasText: 'Taxes' }).click();
  await sidebar(page).locator('.wm-files-file', { hasText: 'Return' }).click();
  await expect.poll(() => app.text(), { timeout: 30_000 }).toContain('an agent says');

  // The menu now offers to stop; Lock does the same: the readable files leave the vault, the note comes back.
  await sidebar(page).locator('.wm-files-folder', { hasText: 'Taxes' }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Stop decrypting in vault folder' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await app.menu('File', 'Lock encrypted documents');
  await expect.poll(() => vaultPaths(page), { timeout: 30_000 }).toEqual(['Taxes (encrypted).md']);
});

/** Moves a file in the vault, as Finder or an agent's `mv` does. */
const moveVault = (page: Page, from: string, to: string) =>
  page.evaluate(([f, t]) => {
    window.__vault[t] = window.__vault[f];
    delete window.__vault[f];
  }, [from, to] as const);

/** The account's document whose name opens (in the app, through the Files pane) as `name`: by its id in the listing. */
const sealedDocs = async (page: Page) => (await cloudDocs(page)).map((d) => ({ ...d, sealed: d.name.startsWith('gde1.') }));

test('in a folder decrypted into the vault: a document moved in is encrypted, one moved out stays encrypted, and Lock leaves nothing behind', { tag: '@heavy' }, async ({ page, app }) => {
  await vaultShell(page, { 'Taxes/Return.md': '# Return\n\nThe secret number is 42.\n', 'Plain.md': '# Plain\n\nNot secret yet.\n' });
  await app.goto('?doc=welcome');
  if (!(await sidebar(page).isVisible())) await app.menu('View', 'Files Sidebar');
  await expect(sidebar(page).locator('.wm-files-folder', { hasText: 'Taxes' })).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(async () => (await cloudDocs(page)).length, { timeout: 30_000 }).toBe(2);
  await encryptFolder(page, 'Taxes');
  await sidebar(page).locator('.wm-files-folder', { hasText: 'Taxes' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Decrypt into vault folder…' }).click();
  await page.getByRole('dialog', { name: 'Decrypt “Taxes” into your vault folder?' }).getByRole('button', { name: 'Decrypt into vault folder' }).click();
  await expect.poll(() => vaultPaths(page), { timeout: 30_000 }).toEqual(['Plain.md', 'Taxes/Return.md']);

  // An ordinary document moved into the folder is encrypted, file, name and all, and stays where it was put.
  const plain = (await cloudDocs(page)).find((d) => !d.name.startsWith('gde1.'))!;
  await moveVault(page, 'Plain.md', 'Taxes/Plain.md');
  await expect.poll(async () => (await sealedDocs(page)).find((d) => d.id === plain.id)?.sealed, { timeout: 30_000 }).toBe(true);
  const file = Buffer.from(await (await page.request.get(`/api/documents/${plain.id}`)).body());
  expect(file.subarray(0, 4).toString()).toBe('GDE1');
  await expect.poll(() => vaultText(page, 'Taxes/Plain.md')).toContain('Not secret yet.');

  // One moved out stays encrypted in the account, and its file stays where it was put, readable, until the session ends.
  const returnId = (await cloudDocs(page)).find((d) => d.id !== plain.id)!.id;
  await moveVault(page, 'Taxes/Return.md', 'Return.md');
  await expect.poll(async () => { const d = (await cloudDocs(page)).find((x) => x.id === returnId); return d ? (d as { folderId?: string | null }).folderId === null : false; }, { timeout: 30_000 }).toBe(true);
  expect((await sealedDocs(page)).find((d) => d.id === returnId)?.sealed).toBe(true);
  await page.waitForTimeout(6000); // a few more of the vault's looks: the file is not taken away while the session lasts
  expect(await vaultText(page, 'Return.md')).toContain('The secret number is 42.');

  // Just before locking, an agent writes a document and leaves a file the vault doesn't sync.
  await writeVault(page, 'Taxes/Late.md', '# Late\n\nWritten a moment before locking.\n');
  await writeVault(page, 'Taxes/data.zip', 'not a document');
  await app.menu('File', 'Lock encrypted documents');
  // Nothing readable is left: the late document reached the account encrypted, the zip is gone, and so is the file moved out.
  await expect.poll(() => vaultPaths(page), { timeout: 60_000 }).toEqual(['Taxes (encrypted).md']);
  const docs = await sealedDocs(page);
  expect(docs).toHaveLength(3);
  expect(docs.every((d) => d.sealed)).toBe(true);
});

test('a vault in a synced folder is refused, saying which service', async ({ page, app }) => {
  await vaultShell(page, { 'Taxes/Return.md': '# Return\n' }, { root: '/Users/someone/Library/CloudStorage/Dropbox/Vault' });
  await app.goto('?doc=welcome');
  if (!(await sidebar(page).isVisible())) await app.menu('View', 'Files Sidebar');
  await expect(sidebar(page).locator('.wm-files-folder', { hasText: 'Taxes' })).toHaveCount(1, { timeout: 30_000 });
  await encryptFolder(page, 'Taxes');
  await sidebar(page).locator('.wm-files-folder', { hasText: 'Taxes' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Decrypt into vault folder…' }).click();
  const refused = page.getByRole('dialog', { name: 'Your Vault Folder Syncs' });
  await expect(refused).toContainText('Dropbox');
  await refused.getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => vaultPaths(page), { timeout: 30_000 }).toEqual(['Taxes (encrypted).md']);
});

test('in a browser there is no vault, so no Decrypt into vault folder', { tag: '@heavy' }, async ({ browser }) => {
  const person = await newPerson(browser, 'no-vault');
  const { page, app } = person;
  await app.goto('?doc=welcome');
  await app.menu('File', 'Open…');
  const dashboard = page.locator('.wm-dashboard');
  await dashboard.getByRole('button', { name: 'New folder', exact: true }).click();
  const field = dashboard.getByRole('textbox', { name: 'Folder name' });
  await field.fill('Taxes');
  await field.press('Enter');
  await page.keyboard.press('Escape');
  if (!(await sidebar(page).isVisible())) await app.menu('View', 'Files Sidebar');
  await encryptFolder(page, 'Taxes');
  await sidebar(page).locator('.wm-files-folder', { hasText: 'Taxes' }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Decrypt folder…' })).toHaveCount(1);
  await expect(page.getByRole('menuitem', { name: 'Decrypt into vault folder…' })).toHaveCount(0);
  await person.context.close();
});
