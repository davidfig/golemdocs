// Encrypted documents and folders (docs/encrypted-folders.md): a folder you already have is encrypted with a key you save, everything in it
// reaches the account sealed, versions included, and it stays locked until the key is entered; a single document can be encrypted too, and
// both decrypted again.

import { expect, test } from '../fixtures';
import { cloudDocs, newPerson } from './helpers';
import { moveTo } from '../files/helpers';

test('encrypt a folder you made: set up a key, lock, unlock with the key (not a mistyped one), decrypt again', { tag: '@heavy' }, async ({ browser }) => {
  const person = await newPerson(browser, 'encrypted');
  const { page, app } = person;
  await app.goto('?doc=welcome');
  await app.menu('File', 'Open…');
  const dashboard = page.locator('.wm-dashboard');

  // An ordinary folder, with a document written in it.
  await dashboard.getByRole('button', { name: 'New folder', exact: true }).click();
  const field = dashboard.getByRole('textbox', { name: 'Folder name' });
  await field.fill('Taxes');
  await field.press('Enter');
  const folder = dashboard.locator('article.wm-folder').filter({ hasText: 'Taxes' });
  await folder.getByRole('button', { name: /Taxes/ }).click();
  await dashboard.getByRole('button', { name: 'New document', exact: true }).first().click();
  await app.type('the secret number is 42');
  await expect.poll(async () => (await cloudDocs(page)).length, { timeout: 30_000 }).toBe(1);
  await expect(page.locator('.wm-sync')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
  const [plain] = await cloudDocs(page);
  expect(plain!.name.startsWith('gde1.')).toBe(false);

  // Encrypt folder…: asked first, then the key is made and has to be saved.
  await page.locator('.wm-files-folder', { hasText: 'Taxes' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Encrypt folder…' }).click();
  await page.getByRole('dialog', { name: 'Encrypt “Taxes”?' }).getByRole('button', { name: 'Encrypt' }).click();
  const setup = page.getByRole('dialog', { name: 'Your Encryption Key' });
  const key = (await setup.locator('.wm-encryption-key').textContent())!;
  expect(key).toMatch(/^golem-key-1-/);
  await setup.getByRole('button', { name: 'I saved it' }).click();
  await expect(setup.getByRole('alert')).toHaveText('That isn’t the same key.');
  await setup.getByLabel('Paste the key again to confirm you saved it').fill(key);
  await setup.getByRole('button', { name: 'I saved it' }).click();
  await expect(setup).toHaveCount(0);

  // The account has the folder encrypted (its own name readable), and the document sealed: name, file and every version.
  await expect.poll(async () => (await cloudDocs(page))[0]?.name.startsWith('gde1.'), { timeout: 30_000 }).toBe(true);
  const folders = (await (await page.request.get('/api/folders')).json()) as { name: string; encrypted?: boolean; wrappedKey?: string }[];
  expect(folders[0]).toMatchObject({ name: 'Taxes', encrypted: true });
  expect(folders[0]!.wrappedKey).toBeTruthy();
  const [doc] = await cloudDocs(page);
  const file = Buffer.from(await (await page.request.get(`/api/documents/${doc!.id}`)).body());
  expect(file.subarray(0, 4).toString()).toBe('GDE1');
  expect(file.includes(Buffer.from('secret'))).toBe(false);
  const versions = (await (await page.request.get(`/api/documents/${doc!.id}/versions`)).json()) as { sealed?: boolean }[];
  expect(versions.every((v) => v.sealed)).toBe(true);
  // The document was open: it is open again, encrypted.
  await expect.poll(() => app.text(), { timeout: 15_000 }).toContain('the secret number is 42');

  // Lock: the document closes; the folder keeps its name, and what is in it shows as "Encrypted document".
  await page.locator('.wm-files-folder', { hasText: 'Taxes' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Lock encrypted documents' }).click();
  const locked = page.locator('.wm-files-file', { hasText: 'Encrypted document' });
  await expect(locked).toHaveCount(1);
  await expect.poll(() => app.text()).not.toContain('secret');

  // Opening it asks for the key: something that isn't one, and a mistyped one, are refused, saying which.
  await locked.click();
  const unlock = page.getByRole('dialog', { name: 'Unlock Encrypted Documents' });
  const keyField = unlock.getByLabel('Encryption key');
  await keyField.fill('golem-key-1-nonsense');
  await unlock.getByRole('button', { name: 'Unlock' }).click();
  await expect(unlock.getByRole('alert')).toHaveText('That isn’t an encryption key. Keys start with golem-key-1-.');
  const typo = key.slice(0, -6) + (key.at(-6) === 'A' ? 'B' : 'A') + key.slice(-5);
  await keyField.fill(typo);
  await unlock.getByRole('button', { name: 'Unlock' }).click();
  await expect(unlock.getByRole('alert')).toContainText('typo');
  await keyField.fill(key);
  await unlock.getByRole('button', { name: 'Unlock' }).click();
  await expect(unlock).toHaveCount(0);
  await expect.poll(() => app.text(), { timeout: 15_000 }).toContain('the secret number is 42');

  // Decrypt folder…: the server can read it again.
  await page.locator('.wm-files-folder', { hasText: 'Taxes' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Decrypt folder…' }).click();
  await page.getByRole('dialog', { name: 'Decrypt “Taxes”?' }).getByRole('button', { name: 'Decrypt' }).click();
  await expect.poll(async () => (await cloudDocs(page))[0]?.name.startsWith('gde1.'), { timeout: 30_000 }).toBe(false);
  const back = Buffer.from(await (await page.request.get(`/api/documents/${doc!.id}`)).body());
  expect(back.subarray(0, 4).toString()).not.toBe('GDE1');

  // A reload ends the session; nothing is encrypted now, so nothing is locked.
  await page.reload();
  await app.ready();
  await expect(page.locator('.wm-files-file', { hasText: 'Encrypted document' })).toHaveCount(0);
  await person.context.close();
});

test('encrypt a single document from the File menu, and lock it', { tag: '@heavy' }, async ({ browser }) => {
  const person = await newPerson(browser, 'encrypted-doc');
  const { page, app } = person;
  await app.blank();
  await app.type('just this one');
  await expect.poll(async () => (await cloudDocs(page)).length, { timeout: 30_000 }).toBe(1);
  await expect(page.locator('.wm-sync')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
  await app.menu('File', 'Encrypt document…');
  await page.getByRole('dialog', { name: /^Encrypt “/ }).getByRole('button', { name: 'Encrypt' }).click();
  const setup = page.getByRole('dialog', { name: 'Your Encryption Key' });
  const key = (await setup.locator('.wm-encryption-key').textContent())!;
  await setup.getByLabel('Paste the key again to confirm you saved it').fill(key);
  await setup.getByRole('button', { name: 'I saved it' }).click();
  await expect.poll(async () => (await cloudDocs(page))[0]?.name.startsWith('gde1.'), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => app.text(), { timeout: 15_000 }).toContain('just this one');
  // Locked, it shows in the Files pane as an encrypted document.
  await app.menu('File', 'Lock encrypted documents');
  await expect(page.locator('.wm-files-file', { hasText: 'Encrypted document' })).toHaveCount(1);
  await person.context.close();
});

test('moving a document out of an encrypted folder in the app asks, then decrypts it; Cancel leaves it encrypted where it was', { tag: '@heavy' }, async ({ browser }) => {
  const person = await newPerson(browser, 'encrypted-move');
  const { page, app } = person;
  await app.goto('?doc=welcome');
  await app.menu('File', 'Open…');
  const dashboard = page.locator('.wm-dashboard');
  await dashboard.getByRole('button', { name: 'New folder', exact: true }).click();
  const field = dashboard.getByRole('textbox', { name: 'Folder name' });
  await field.fill('Taxes');
  await field.press('Enter');
  await dashboard.locator('article.wm-folder').filter({ hasText: 'Taxes' }).getByRole('button', { name: /Taxes/ }).click();
  await dashboard.getByRole('button', { name: 'New document', exact: true }).first().click();
  await app.type('moving out');
  await expect.poll(async () => (await cloudDocs(page)).length, { timeout: 30_000 }).toBe(1);
  await expect(page.locator('.wm-sync')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });

  const folderRow = page.locator('.wm-files-folder', { hasText: 'Taxes' });
  await folderRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Encrypt folder…' }).click();
  await page.getByRole('dialog', { name: 'Encrypt “Taxes”?' }).getByRole('button', { name: 'Encrypt' }).click();
  const setup = page.getByRole('dialog', { name: 'Your Encryption Key' });
  await setup.getByLabel('Paste the key again to confirm you saved it').fill((await setup.locator('.wm-encryption-key').textContent())!);
  await setup.getByRole('button', { name: 'I saved it' }).click();
  await expect.poll(async () => (await cloudDocs(page))[0]?.name.startsWith('gde1.'), { timeout: 30_000 }).toBe(true);
  const [doc] = await cloudDocs(page);
  const folderOf = async () => ((await cloudDocs(page)).find((d) => d.id === doc!.id) as { folderId?: string | null } | undefined)?.folderId;
  const inFolder = await folderOf();
  expect(inFolder).toBeTruthy();

  // Move… to the top level: asked first; Cancel leaves it encrypted, where it was.
  const moveOut = async () => {
    if (!(await page.locator('.wm-files-file').first().isVisible())) await folderRow.click();
    await page.locator('.wm-files-file').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move…' }).click();
    await moveTo(page, 'Documents');
    return page.getByRole('dialog', { name: /out of the encrypted folder\?$/ });
  };
  await (await moveOut()).getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(2000);
  expect(await folderOf()).toBe(inFolder);
  expect((await cloudDocs(page))[0]!.name.startsWith('gde1.')).toBe(true);

  // Decrypt and move: moved to the top level, and readable again.
  await (await moveOut()).getByRole('button', { name: 'Decrypt and move' }).click();
  await expect.poll(async () => (await cloudDocs(page))[0]?.name.startsWith('gde1.'), { timeout: 30_000 }).toBe(false);
  expect(await folderOf()).toBeNull();
  const file = Buffer.from(await (await page.request.get(`/api/documents/${doc!.id}`)).body());
  expect(file.subarray(0, 4).toString()).not.toBe('GDE1');
  await person.context.close();
});
