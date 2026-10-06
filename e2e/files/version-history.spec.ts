// File ▸ Version History and File ▸ Trash: earlier versions of a document (kept in this browser, and in the account), opened as new
// documents, named, renamed and deleted; and deleted documents brought back from the trash.

import type { Page } from '@playwright/test';
import { expect, test, type App } from './fixtures';
import { waitForSaved } from './helpers';
import { dialog } from '../editing/helpers';
import { cloudDocs, newPerson, waitForCloudDoc } from '../collab/helpers';

const history = (page: Page) => dialog(page, 'Version History');
const rows = (page: Page) => history(page).locator('.wm-history-row');
const dashboard = (page: Page) => page.locator('.wm-dashboard');

/** A document with `first`, saved, and then `second` added and saved too: the first save is what a checkpoint keeps. */
async function twoSaves(app: App, first: string, second: string): Promise<void> {
  await app.blank();
  await app.type(first);
  await waitForSaved(app.page);
  await app.type(second);
  await expect.poll(() => app.text(), { timeout: 15_000 }).toBe(first + second);
  await waitForSaved(app.page);
}

/** Opens the dialog until a version shows (the second save may still be on its way). */
async function openHistoryWithVersions(app: App): Promise<void> {
  await expect(async () => {
    await app.menu('File', 'Version History');
    await expect(history(app.page)).toBeVisible();
    await expect(rows(app.page).first()).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
}

test('Version History lists what was kept, and opening a version makes a new document and leaves this one alone', async ({ app, page }) => {
  await twoSaves(app, 'first draft', ' and more');
  await openHistoryWithVersions(app);
  await expect(history(page).getByText('Earlier versions of this document are kept as you edit.')).toBeVisible();
  await expect(rows(page).first().locator('.wm-history-source')).toHaveText(/On this device|In your account/);
  await rows(page).first().getByRole('button', { name: 'Open as New Document' }).click();
  await expect(history(page)).toBeHidden();
  // The new document holds what the version had.
  await expect.poll(() => app.text(), { timeout: 20_000 }).toBe('first draft');
  // Both are in the library now: the one that was edited and the one made from its version.
  await app.menu('File', 'Open…');
  await expect(dashboard(page).locator('article.wm-card')).toHaveCount(2);
});

test('a version can be saved under a name, renamed and deleted', async ({ app, page }) => {
  await twoSaves(app, 'alpha', ' beta');
  await app.menu('File', 'Version History');
  const field = history(page).getByRole('textbox', { name: 'Name this version' });
  const save = history(page).getByRole('button', { name: 'Save Version' });
  await expect(save).toBeDisabled();
  await field.fill('Sent to Sam');
  await save.click();
  await expect(history(page).locator('.wm-history-name-text', { hasText: 'Sent to Sam' }).first()).toBeVisible();
  await expect(field).toHaveValue('');

  const named = rows(page).filter({ hasText: 'Sent to Sam' }).first();
  await named.getByRole('button', { name: 'Rename' }).click();
  await history(page).getByRole('textbox', { name: 'Version name' }).fill('Final');
  await history(page).getByRole('button', { name: 'OK' }).click();
  await expect(history(page).locator('.wm-history-name-text', { hasText: 'Final' }).first()).toBeVisible();
  await expect(history(page).locator('.wm-history-name-text', { hasText: 'Sent to Sam' })).toHaveCount(0);

  const before = await rows(page).count();
  await rows(page).filter({ hasText: 'Final' }).first().getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog', { name: 'Delete this version?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(rows(page)).toHaveCount(before - 1);
});

test('a new document has no history yet, and the dialog closes', async ({ app, page }) => {
  await app.blank();
  await app.menu('File', 'Version History');
  await expect(history(page)).toBeVisible();
  await expect(history(page).getByText(/No earlier versions yet|has not been saved yet/)).toBeVisible();
  await history(page).getByRole('button', { name: 'Close' }).first().click();
  await expect(history(page)).toBeHidden();
});

test('a deleted document goes to the trash for 30 days and Restore brings it back', { tag: '@heavy' }, async ({ browser }) => {
  const person = await newPerson(browser, 'trash');
  const { page, app } = person;
  await app.blank();
  await app.type('keep me');
  await expect.poll(async () => (await cloudDocs(page)).length, { timeout: 30_000 }).toBe(1);
  await app.menu('File', 'Open…');
  const card = dashboard(page).locator('article.wm-card').first();
  await expect(card).toBeVisible();
  await card.hover();
  await card.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(dashboard(page).locator('article.wm-card')).toHaveCount(0);
  await expect.poll(async () => (await cloudDocs(page)).length).toBe(0);

  // The Documents screen has its own Trash button: the menu bar is behind it.
  await dashboard(page).getByRole('button', { name: 'Trash' }).click();
  const trash = dialog(page, 'Trash');
  await expect(trash).toBeVisible();
  await expect(trash.getByText('Deleted documents are kept here for 30 days')).toBeVisible();
  await expect(trash.locator('.wm-history-row')).toHaveCount(1);
  await trash.getByRole('button', { name: 'Restore' }).click();
  await expect(trash.getByText('The trash is empty.')).toBeVisible();
  await trash.getByRole('button', { name: 'Close' }).first().click();
  await expect(dashboard(page).locator('article.wm-card')).toHaveCount(1);
  await expect.poll(async () => (await cloudDocs(page)).length).toBe(1);
  await person.context.close();
});

test('a document in the account keeps versions there too, and one opens as a new document in the account', { tag: '@heavy' }, async ({ browser }) => {
  const person = await newPerson(browser, 'versions');
  const { page, app } = person;
  await app.blank();
  await app.type('first draft');
  const doc = await waitForCloudDoc(page);
  await app.type(' and more');
  await expect.poll(async () => ((await (await page.request.get(`/api/documents/${doc.id}/versions`)).json()) as unknown[]).length, { timeout: 30_000 }).toBeGreaterThan(0);

  await app.menu('File', 'Version History');
  await expect(history(page)).toBeVisible();
  const account = rows(page).filter({ hasText: 'In your account' }).first();
  await expect(account).toBeVisible();
  await account.getByRole('button', { name: 'Open as New Document' }).click();
  await expect(history(page)).toBeHidden();
  await expect.poll(async () => (await cloudDocs(page)).length, { timeout: 30_000 }).toBe(2);
  await expect.poll(() => app.text(), { timeout: 30_000 }).toBe('first draft');
  await person.context.close();
});
