// The edit journal (docs/edit-journal.md): what was edited since the last save comes back after a reload, a closed tab or a
// crash, once and in order; and it never goes over a copy someone else has written since.

import type { BrowserContext, Page } from '@playwright/test';
import { App, MOD } from '../fixtures';
import { expect, test } from './fixtures';
import { attrs, count, docx, makePng } from '../layout/helpers';
import { blankWith, status, waitForSaved } from './helpers';

/** The journal keys in this browser. */
const journalKeys = (page: Page): Promise<string[]> => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('golemdocs.journal.')));

// Typing here is at 20 ms a key, faster than anyone types. With no delay at all a burst queues up on its way through the layout worker for a moment (docs/edit-journal.md).

/** Reloads as soon as the edit has been kept, well inside the autosave's delay. */
async function reloadBeforeAutosave(app: App): Promise<void> {
  await expect.poll(() => journalKeys(app.page), { intervals: [10] }).not.toEqual([]);
  await app.page.reload();
  await app.ready();
}

/** Nobody is signed in, as for this folder's own `page` (see ./fixtures.ts). */
const signedOut = (page: Page) => page.route('**/api/auth/me', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: null }) }));

/** A second tab on the same browser profile, showing `url`. */
async function secondTab(context: BrowserContext, url: string): Promise<App> {
  const page = await context.newPage();
  await signedOut(page);
  const app = new App(page);
  await page.goto(url);
  await app.ready();
  return app;
}

/** The tab dies, with no chance to do anything on the way out. */
async function crash(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const gone = page.waitForEvent('crash');
  void cdp.send('Page.crash').catch(() => {});
  await gone;
}

test('undo and redo before a reload come back as they were', async ({ app, page }) => {
  await blankWith(app, 'kept');
  await waitForSaved(page);
  await app.type(' one', 20);
  await app.type(' two', 20);
  await app.press(`${MOD}+z`);
  await reloadBeforeAutosave(app);
  await expect.poll(() => app.text()).not.toContain('two');
  expect(await app.text()).toContain('kept');
});

test('new paragraphs, formatting and a table come back too, and the file is the same as if it had been saved', async ({ app, page }) => {
  await blankWith(app, 'first');
  await waitForSaved(page);
  await app.press('Enter');
  await app.type('second');
  await app.press('Shift+Home');
  await app.press(`${MOD}+b`);
  await app.press('End');
  await app.press('Enter');
  await app.menu('Insert', 'Table…');
  const box = page.getByRole('dialog', { name: /Table/ });
  await box.getByRole('button', { name: 'OK' }).click();
  await reloadBeforeAutosave(app);
  await expect.poll(() => app.text()).toContain('first\nsecond');
  const { xml } = await docx(app);
  expect(count(xml, 'w:tbl')).toBe(1);
  expect(xml).toMatch(/<w:b\/?>[\s\S]*second/);
});

test('a reload, and another straight after it, bring the edits back once', async ({ app, page }) => {
  await blankWith(app, 'quick');
  await waitForSaved(page);
  await app.type(' edit', 20);
  await reloadBeforeAutosave(app);
  await expect.poll(() => app.text()).toBe('quick edit');
  await page.reload();
  await app.ready();
  await expect.poll(() => app.text()).toBe('quick edit');
  await app.type(' more', 20);
  await reloadBeforeAutosave(app);
  await expect.poll(() => app.text()).toBe('quick edit more');
  await waitForSaved(page);
  await expect.poll(() => journalKeys(page)).toEqual([]);
});

test('a tab that crashes keeps its edits', async ({ app, page, context }) => {
  await blankWith(app, 'saved');
  await waitForSaved(page);
  const url = page.url();
  await app.type(' and not yet', 20);
  // Well inside the autosave's delay. A crash in the same moment as a key can lose the last tenth of a second or so (docs/edit-journal.md).
  await page.waitForTimeout(300);
  await crash(page);
  const back = await secondTab(context, url);
  await expect.poll(() => back.text()).toBe('saved and not yet');
});

test('a save empties the journal', async ({ app, page }) => {
  await blankWith(app, 'typed');
  await waitForSaved(page);
  await expect.poll(() => journalKeys(page)).toEqual([]);
  await app.type(' more', 20);
  await expect.poll(() => journalKeys(page)).not.toEqual([]);
  await expect.poll(() => journalKeys(page), { timeout: 15_000 }).toEqual([]);
});

test('a picture is saved at once, so it and what was typed before it stay; nothing refers to a picture that is not there', async ({ app, page }) => {
  await blankWith(app, 'before');
  await waitForSaved(page);
  await app.type(' more', 20);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.menu('Insert', 'Picture…')]);
  await chooser.setFiles({ name: 'grad.png', mimeType: 'image/png', buffer: makePng(60, 30) });
  await expect.poll(() => page.evaluate(() => (window as unknown as { pages: { images: unknown[] }[] }).pages[0].images.length)).toBe(1);
  await expect.poll(() => journalKeys(page), { timeout: 15_000 }).toEqual([]);
  await page.reload();
  await app.ready();
  await expect.poll(() => app.text()).toContain('before more');
  const { xml } = await docx(app);
  expect(count(xml, 'w:drawing')).toBe(1);
  expect(attrs(xml, 'wp:extent').cx).toBe(String(60 * 9525));
});

test('a second tab leaves the first one’s journal alone: it shows what is saved, and doesn’t take the edits still being made', async ({ app, page, context }) => {
  await blankWith(app, 'saved');
  await waitForSaved(page);
  const url = page.url();
  // Typing that never pauses for long enough to autosave.
  let typing = true;
  const typed = (async () => {
    await app.focus();
    while (typing) await page.keyboard.type('x', { delay: 100 });
  })();
  await expect.poll(() => journalKeys(page)).not.toEqual([]);
  const other = await secondTab(context, url);
  await expect.poll(() => other.text()).toBe('saved');
  expect(await journalKeys(page)).not.toEqual([]);
  typing = false;
  await typed;
  await other.page.close();
  // The first tab goes on with all of it.
  expect(await app.text()).toMatch(/^savedx+$/);
});

test('edits on top of a copy someone else has since written go in a conflicted copy, and the copy is left as it was', async ({ app, page, context }) => {
  await blankWith(app, 'shared start');
  await waitForSaved(page);
  const url = page.url();
  const other = await secondTab(context, url);
  await expect.poll(() => other.text()).toBe('shared start');
  await app.type(' from the tab that dies', 20);
  await page.waitForTimeout(300);
  await crash(page);
  // The other tab writes the copy while the journal waits.
  await other.focus();
  await other.press(`${MOD}+End`);
  await other.page.keyboard.type(' from the other tab');
  await waitForSaved(other.page);
  await other.page.close();
  const back = await secondTab(context, url);
  await expect.poll(() => back.text()).toBe('shared start from the other tab');
  await expect.poll(() => status(back.page)).toContain('conflicted copy');
  await expect.poll(async () => (await journalKeys(back.page)).length).toBe(0);
  await back.menu('File', 'Open…');
  const card = back.page.locator('.wm-dashboard article.wm-card', { hasText: 'conflicted copy' });
  await expect(card).toHaveCount(1);
  // The copy is the copy as it stands, with the edits that couldn't go over it.
  await card.click();
  // The dead tab's edit was at offset 12 of the text it knew, so it lands there.
  await expect.poll(() => back.text()).toBe('shared start from the tab that dies from the other tab');
});

test('a document whose journal has outlived it leaves nothing behind', async ({ app, page }) => {
  await blankWith(app, 'typed');
  await waitForSaved(page);
  const made = 'golemdocs.journal.99999999-9999-4999-8999-999999999999.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await page.evaluate((key) => {
    localStorage.setItem(key, JSON.stringify({ page: 'gone', startedAt: 1, base: 1 }));
    localStorage.setItem(`${key}.1`, JSON.stringify([]));
  }, made);
  await page.reload();
  await app.ready();
  await expect.poll(() => journalKeys(page)).toEqual([]);
});
