// The trash: deleted documents, kept 30 days, shown as a folder in File › Open (its Trash button) and as the last entry of the Files
// sidebar. Each opens read-only to be looked at, and can be restored or deleted for good; Empty Trash deletes them all.

import type { Browser, Page } from '@playwright/test';
import { App, expect, test } from './fixtures';
import { waitForSaved } from './helpers';
import { cloudDocs, newPerson, signedOutContext } from '../collab/helpers';

const dashboard = (page: Page) => page.locator('.wm-dashboard');
const cards = (page: Page) => dashboard(page).locator('article.wm-card');
const sidebar = (page: Page) => page.locator('.wm-files');
const trashEntry = (page: Page) => sidebar(page).getByRole('treeitem', { name: /Trash$/ });
const trashed = (page: Page) => sidebar(page).locator('.wm-files-trashed');
const confirm = (page: Page) => page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();

/** A guest with one document saved in this browser, typed as `words`. */
async function guestWithDocument(browser: Browser, words: string): Promise<{ page: Page; app: App; close: () => Promise<void> }> {
  const context = await signedOutContext(browser);
  const page = await context.newPage();
  const app = new App(page);
  await app.blank();
  await app.type(words);
  await waitForSaved(page);
  return { page, app, close: () => context.close() };
}

/** Shows the Files sidebar (a new browser context may already show it: it is open by default in a wide window). */
async function showSidebar(app: App): Promise<void> {
  await app.ready();
  if (!(await sidebar(app.page).isVisible())) await app.menu('View', 'Files Sidebar');
  await expect(sidebar(app.page)).toBeVisible();
}

/** Deletes the first document in File › Open (which stays open). */
async function deleteFirstCard(page: Page): Promise<void> {
  const card = cards(page).first();
  await card.hover();
  await card.getByRole('button', { name: 'Delete' }).click();
  await confirm(page);
}

test('File › Open shows Trash as a folder: a deleted document is there, Restore brings it back, Delete Forever ends it', async ({ browser }) => {
  const { page, app, close } = await guestWithDocument(browser, 'only on this device');
  await app.menu('File', 'Open…');
  await deleteFirstCard(page);
  await expect(cards(page)).toHaveCount(0);

  // The Trash button is there for everyone, not only for an account.
  await dashboard(page).getByRole('button', { name: 'Trash', exact: true }).click();
  const crumbs = dashboard(page).getByRole('navigation', { name: 'Location' });
  await expect(crumbs.getByRole('button', { name: 'Trash' })).toHaveAttribute('aria-current', 'page');
  await expect(dashboard(page).getByText('Deleted documents are kept here for 30 days')).toBeVisible();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).locator('.wm-badge')).toHaveText('On this device');
  await expect(cards(page).locator('.wm-card-meta')).toContainText('Kept until');
  await dashboard(page).screenshot({ path: test.info().outputPath('trash-dashboard.png') });
  await cards(page).first().hover();
  await cards(page).first().getByRole('button', { name: 'Restore' }).click();
  await expect(dashboard(page).getByText('The trash is empty.')).toBeVisible();
  await crumbs.getByRole('button', { name: 'Documents' }).click();
  await expect(cards(page)).toHaveCount(1);

  // Deleted again, and this time for good, from its right-click menu.
  await deleteFirstCard(page);
  await dashboard(page).getByRole('button', { name: 'Trash', exact: true }).click();
  await cards(page).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete Forever' }).click();
  await confirm(page);
  await expect(dashboard(page).getByText('The trash is empty.')).toBeVisible();
  await expect(dashboard(page).getByRole('button', { name: 'Empty Trash' })).toBeDisabled();
  await close();
});

test('the Files sidebar ends with Trash, which opens like a folder and restores from its menu', async ({ browser }) => {
  const { page, app, close } = await guestWithDocument(browser, 'kept for later');
  await showSidebar(app);
  await expect(trashEntry(page)).toHaveAttribute('aria-expanded', 'false');
  // The last entry, after the documents.
  await expect(sidebar(page).locator('.wm-files-row').last()).toHaveAttribute('data-row', 'f:#trash');

  const doc = sidebar(page).locator('.wm-files-file').first();
  const name = (await doc.textContent())!.trim();
  await doc.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await confirm(page);
  await expect(sidebar(page).locator('.wm-files-file')).toHaveCount(0);

  // Opened from the keyboard, as a folder is.
  await trashEntry(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(trashEntry(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(trashed(page)).toHaveCount(1);
  await expect(trashed(page)).toContainText(name);
  await expect(trashed(page)).toHaveAttribute('aria-description', /Deleted .* · Kept until .* · On this device/);
  await page.keyboard.press('ArrowDown');
  await expect(trashed(page)).toBeFocused();
  await sidebar(page).screenshot({ path: test.info().outputPath('trash-sidebar.png') });

  await trashed(page).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Restore' }).click();
  await expect(sidebar(page).locator('.wm-files-file')).toHaveCount(1);
  await expect(trashed(page)).toHaveCount(0);
  await expect(sidebar(page).getByText('The trash is empty.')).toBeVisible();

  // Its menu empties it; with nothing in it there is nothing to empty.
  await trashEntry(page).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Empty Trash' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await close();
});

test('a deleted document opens read-only beside Restore, and File › Trash goes to Trash in the sidebar', async ({ browser }) => {
  const { page, app, close } = await guestWithDocument(browser, 'look before you restore');
  await showSidebar(app);
  await sidebar(page).locator('.wm-files-file').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await confirm(page);

  // File › Trash, with the sidebar showing: Trash there, open, with the keyboard on it.
  await app.menu('File', 'Trash');
  await expect(trashEntry(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(trashEntry(page)).toBeFocused();
  await expect(trashed(page)).toHaveCount(1);

  const name = (await trashed(page).textContent())!.trim();
  await trashed(page).click();
  const preview = page.getByRole('dialog', { name });
  await expect(preview).toBeVisible();
  await expect(preview.getByText(/Deleted .* · Kept until .* · On this device/)).toBeVisible();
  // The viewer in the frame has it: the status line goes once it is laid out, and the words are there to find.
  await expect(preview.locator('.wm-trash-preview-status')).toBeHidden({ timeout: 30_000 });
  const frame = page.frameLocator('.wm-trash-preview-frame');
  await expect(frame.locator('.wm-footer')).toBeVisible();
  await preview.screenshot({ path: test.info().outputPath('trash-preview.png') });

  await preview.getByRole('button', { name: 'Restore' }).click();
  await expect(preview).toBeHidden();
  await expect(trashed(page)).toHaveCount(0);
  await expect(sidebar(page).locator('.wm-files-file')).toHaveCount(1);
  await close();
});

test('Empty Trash counts the documents off in a progress card, and a document from the account opens read-only too', { tag: '@heavy' }, async ({ browser }) => {
  const person = await newPerson(browser, 'trash');
  const { page, app } = person;
  await app.blank();
  await app.type('in the account');
  await expect.poll(async () => (await cloudDocs(page)).length, { timeout: 30_000 }).toBe(1);
  await app.menu('File', 'Open…');
  await deleteFirstCard(page);
  await expect.poll(async () => (await cloudDocs(page)).length).toBe(0);

  // File › Trash, with File › Open closed and no sidebar: Trash in File › Open.
  await page.keyboard.press('Escape');
  await expect(dashboard(page)).toBeHidden();
  if (await sidebar(page).isVisible()) await app.menu('View', 'Files Sidebar');
  await app.menu('File', 'Trash');
  await expect(dashboard(page)).toBeVisible();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).locator('.wm-badge')).toHaveText('In your account');
  const name = (await cards(page).locator('.wm-card-title').textContent())!.trim();
  await cards(page).first().getByRole('button', { name: `Open ${name}` }).click();
  const preview = page.getByRole('dialog', { name });
  await expect(preview.locator('.wm-trash-preview-status')).toBeHidden({ timeout: 30_000 });
  await preview.getByRole('button', { name: 'Close' }).last().click();
  await expect(preview).toBeHidden();

  // Each document is deleted by its own request: hold them so the progress can be seen while they wait.
  let release = (): void => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/trash/*', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    await held;
    await route.continue();
  });
  await dashboard(page).getByRole('button', { name: 'Empty Trash' }).click();
  await confirm(page);
  const progress = page.locator('.wm-progress');
  await expect(progress).toContainText('Emptying the trash…');
  await expect(progress).toContainText('0 of 1');
  await expect(cards(page).first()).toHaveClass(/wm-card-going/);
  await expect(dashboard(page).getByRole('button', { name: 'Empty Trash' })).toBeDisabled();
  release();
  await expect(dashboard(page).getByText('The trash is empty.')).toBeVisible();
  await expect(progress).toBeHidden();
  await person.context.close();
});
