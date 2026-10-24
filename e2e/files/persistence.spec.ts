// Saving without a Save command: autosave, what reopens after a reload, Open Recent, the address
// bar's `?doc=` and Clear Local Data.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { blankWith, formatLabel, importFile, status, text, waitForOpen, waitForSaved } from './helpers';

const dialog = (page: Page) => page.getByRole('dialog').filter({ hasText: 'Clear Local Data' });

test('a first visit opens the welcome document', async ({ app, page }) => {
  await page.goto('/');
  await app.ready();
  expect(await app.text()).toContain('Welcome to Golem Docs');
  await expect(page).toHaveTitle('Welcome to Golem Docs - Golem Docs');
  // The welcome document has an address of its own.
  await expect.poll(() => new URL(page.url()).pathname).toBe('/welcome');
});

test('typing is saved by itself, and a reload brings it back', async ({ app, page }) => {
  await blankWith(app, 'Saved without asking', 'Second paragraph');
  await waitForSaved(page, 'Document1.docx');
  await expect.poll(() => page.url()).toMatch(/doc=local%3A[\w-]+/);
  await page.reload();
  await app.ready();
  await expect.poll(() => app.text()).toBe('Saved without asking\nSecond paragraph');
  await expect(page).toHaveTitle('Document1.docx - Golem Docs');
  expect(await formatLabel(page)).toBe('Word Document');
});

// Suspected bug: the save on pagehide is asynchronous (a round trip to the layout worker, then an IndexedDB write), so edits made within the 1 s autosave delay before a reload are lost.
test.fixme('edits made right before a reload are not lost', async ({ app, page }) => {
  await blankWith(app, 'quick edit');
  await waitForSaved(page);
  await app.type(' and a last-second one');
  await page.reload();
  await app.ready();
  expect(await app.text()).toBe('quick edit and a last-second one');
});

test('opening the bare address carries on with the document that was open last', async ({ app, page }) => {
  await blankWith(app, 'the one I was writing');
  await waitForSaved(page);
  await page.goto('/');
  await app.ready();
  await expect.poll(() => app.text()).toBe('the one I was writing');
  await expect.poll(() => page.url()).toMatch(/doc=local%3A/);
});

// Suspected bug: opening a saved document from the dashboard doesn't record it as the last one open (only a save does), so a bare address reopens the last document that was saved instead.
test.fixme('the document last opened is the one that comes back, not the newest edit elsewhere', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importFile(app, text('first.txt', 'one'));
  await waitForSaved(page, 'first.txt');
  await importFile(app, text('second.txt', 'two'));
  await waitForSaved(page, 'second.txt');
  // Go back to the first, without changing it.
  await app.menu('File', 'Open…');
  await page.getByRole('button', { name: 'Open first.txt' }).click();
  await waitForOpen(app, 'first.txt');
  await page.goto('/');
  await app.ready();
  expect(await app.text()).toBe('one');
});

test('the welcome document is only saved once it has been changed', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await app.menu('File', 'Open…');
  await expect(page.locator('.wm-dashboard article.wm-card')).toHaveCount(0);
  // Escape only closes it once the search box has the focus.
  await expect(page.getByRole('searchbox', { name: 'Search documents' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.wm-dashboard')).toBeHidden();
  await app.focus();
  await app.type('my note ');
  await waitForSaved(page, 'Welcome to Golem Docs.*');
  await app.menu('File', 'Open…');
  await expect(page.locator('.wm-dashboard article.wm-card')).toHaveCount(1);
});

test('each New document gets the next name', async ({ app, page }) => {
  await app.blank();
  await expect(page).toHaveTitle('Document1 - Golem Docs');
  await app.menu('File', 'New');
  await expect(page).toHaveTitle('Document2 - Golem Docs');
  await app.menu('File', 'New');
  await expect(page).toHaveTitle('Document3 - Golem Docs');
});

test('Open Recent lists what is saved and opens the one chosen', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await app.menubar.getByRole('menuitem', { name: /^File$/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /^Open Recent/ }).click();
  await expect(page.getByRole('menu').last().getByRole('menuitem', { name: 'None' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await importFile(app, text('older.md', '# older'));
  await waitForSaved(page, 'older.md');
  await importFile(app, text('newer.txt', 'newer'));
  await waitForSaved(page, 'newer.txt');

  await app.menu('File', 'Open Recent', 'older.md');
  await waitForOpen(app, 'older.md');
  expect(await app.text()).toBe('older');
  expect(await formatLabel(page)).toBe('Markdown');
});

test('an address that names a document that is gone leaves nothing open and says so', async ({ app, page }) => {
  await page.goto('/?doc=local:does-not-exist');
  await app.ready();
  await expect.poll(() => status(page)).toBe('That document is no longer saved in this browser');
  await expect(page).toHaveTitle('Golem Docs');
  await expect(page.locator('.wm-nothing-open')).toBeVisible();
  await expect(page).toHaveURL(/doc=none/);
});

test('an address with an unknown document name opens the fonts sample', async ({ app, page }) => {
  await page.goto('/?doc=something-else');
  await app.ready();
  await expect(page).toHaveTitle('Fonts - Golem Docs');
});

test('an address with ?doc=local:… opens that saved document', async ({ app, page }) => {
  await blankWith(app, 'addressable');
  await waitForSaved(page);
  const address = page.url();
  await page.goto('/?doc=welcome');
  await app.ready();
  await page.goto(address);
  await app.ready();
  await expect.poll(() => app.text()).toBe('addressable');
});

// --- Clear Local Data ---------------------------------------------------------------------------

test('Clear Local Data asks first, saying what will go, and Cancel keeps everything', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await app.menu('File', 'Clear Local Data…');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText('This deletes everything saved in this browser, along with your toolbar layout. It can’t be undone.');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toBeHidden();

  await importFile(app, text('keep.txt', 'keep me'));
  await waitForSaved(page, 'keep.txt');
  await app.menu('File', 'Clear Local Data…');
  await expect(dialog(page)).toContainText('This deletes the one document saved in this browser');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toBeHidden();
  // Nothing happened: the document is still there, and still saved.
  expect(await app.text()).toBe('keep me');
  await page.reload();
  await app.ready();
  await expect.poll(() => app.text()).toBe('keep me');
});

test('Clear Local Data counts the documents, and Delete Everything wipes them and starts over', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  for (const file of [text('a.txt', 'a'), text('b.txt', 'b')]) {
    await importFile(app, file);
    await waitForSaved(page, file.name);
  }
  await page.evaluate(() => localStorage.setItem('word.viewMode', 'normal'));
  await app.menu('File', 'Clear Local Data…');
  await expect(dialog(page)).toContainText('This deletes all 2 documents saved in this browser');
  await dialog(page).getByRole('button', { name: 'Delete Everything' }).click();

  // The page starts afresh, with the welcome document.
  await app.ready();
  await expect(page).toHaveTitle('Welcome to Golem Docs - Golem Docs');
  expect(await page.evaluate(() => localStorage.getItem('word.viewMode'))).toBeNull();
  await app.menu('File', 'Open…');
  await expect(page.locator('.wm-dashboard article.wm-card')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // A reload does not bring anything back.
  await page.goto('/');
  await app.ready();
  expect(await app.text()).toContain('Welcome to Golem Docs');
});

test('Escape also cancels Clear Local Data', async ({ app, page }) => {
  await blankWith(app, 'safe');
  await waitForSaved(page);
  await app.menu('File', 'Clear Local Data…');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await page.reload();
  await app.ready();
  await expect.poll(() => app.text()).toBe('safe');
});
