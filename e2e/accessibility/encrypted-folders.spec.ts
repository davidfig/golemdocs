// Encryption with the keyboard alone (docs/encrypted-folders.md): a document encrypted, locked and unlocked from the File menu, the key typed
// into labelled fields, a dialog closed with Escape, and a locked document said in words, not only by its padlock.

import { expect, test } from '../fixtures';
import { cloudDocs, newPerson } from '../collab/helpers';

test('a document can be encrypted, locked and unlocked from the File menu with the keyboard', { tag: '@heavy' }, async ({ browser }) => {
  const person = await newPerson(browser, 'encrypted-keys');
  const { page, app } = person;
  await app.blank();
  await app.type('private words');
  await expect.poll(async () => (await cloudDocs(page)).length, { timeout: 30_000 }).toBe(1);
  await expect(page.locator('.wm-sync')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });

  // Encrypt document…: the question, then the key; the field to type it back into has the focus and a name; Enter sends the form.
  await app.menu('File', 'Encrypt document…');
  const ask = page.getByRole('dialog', { name: /^Encrypt “/ });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Encrypt' }).focus();
  await page.keyboard.press('Enter');
  const setup = page.getByRole('dialog', { name: 'Your Encryption Key' });
  const confirm = setup.getByLabel('Paste the key again to confirm you saved it');
  await expect(confirm).toBeFocused();
  const key = (await setup.locator('.wm-encryption-key').textContent())!;
  await page.keyboard.type(key);
  // The progress dialog is gone as soon as one document is done, so it is recorded as it opens: named for what it is doing (not the
  // question asked before), with a progress bar and a status line.
  await page.evaluate(() => {
    const seen: { name: string; bar: boolean; status: boolean }[] = [];
    (window as unknown as { seenProgress: typeof seen }).seenProgress = seen;
    new MutationObserver(() => {
      const dialog = document.querySelector('dialog.wm-encryption-progress');
      if (!dialog || seen.length) return;
      const id = dialog.getAttribute('aria-labelledby');
      seen.push({ name: (id && document.getElementById(id)?.textContent) || dialog.getAttribute('aria-label') || '', bar: !!dialog.querySelector('[role="progressbar"]'), status: !!dialog.querySelector('[role="status"]') });
    }).observe(document.body, { childList: true, subtree: true, attributes: true });
  });
  await page.keyboard.press('Enter');
  await expect(setup).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { seenProgress: unknown[] }).seenProgress[0])).toEqual({ name: expect.stringMatching(/^Encrypting “/), bar: true, status: true });
  await expect.poll(async () => (await cloudDocs(page))[0]?.name.startsWith('gde1.'), { timeout: 30_000 }).toBe(true);

  // Locked: said in words in the Files pane.
  await app.menu('File', 'Lock encrypted documents');
  await expect(page.locator('.wm-files').getByRole('treeitem', { name: /Encrypted document/ })).toHaveCount(1);

  // Unlock: the key field has the focus and a name; Escape closes the dialog; the key and Enter unlock.
  await app.menu('File', 'Unlock encrypted documents…');
  const unlock = page.getByRole('dialog', { name: 'Unlock Encrypted Documents' });
  await expect(unlock.getByLabel('Encryption key')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(unlock).toHaveCount(0);
  await app.menu('File', 'Unlock encrypted documents…');
  await expect(unlock.getByLabel('Encryption key')).toBeFocused();
  await page.keyboard.type('golem-key-1-wrong');
  await page.keyboard.press('Enter');
  await expect(unlock.getByRole('alert')).toContainText('isn’t an encryption key');
  await unlock.getByLabel('Encryption key').fill('');
  await page.keyboard.type(key);
  await page.keyboard.press('Enter');
  await expect(unlock).toHaveCount(0);
  await expect(page.locator('.wm-files').getByRole('treeitem', { name: /Encrypted document/ })).toHaveCount(0);
  await person.context.close();
});
