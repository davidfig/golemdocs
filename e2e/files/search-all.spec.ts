// Edit ▸ Search All Documents (Ctrl/Cmd+Shift+F): finds words and #tags in every saved document.

import type { Page } from '@playwright/test';
import { MOD, expect, test, type App } from './fixtures';
import { importFile, text } from './helpers';

const panel = (page: Page) => page.locator('dialog.wm-search');
const input = (page: Page) => panel(page).getByRole('textbox', { name: 'Search words or #tags in every document' });
const rows = (page: Page) => panel(page).locator('.wm-search-row');

/** Waits until a document called `name` is kept in this browser (read from its storage: the status bar's message can be replaced before it is seen). */
async function waitForKept(page: Page, name: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (wanted) =>
            new Promise<boolean>((resolve) => {
              const open = indexedDB.open('word');
              open.onerror = () => resolve(false);
              open.onsuccess = () => {
                try {
                  const all = open.result.transaction('meta').objectStore('meta').getAll();
                  all.onsuccess = () => resolve((all.result as { name: string }[]).some((d) => d.name === wanted));
                  all.onerror = () => resolve(false);
                } catch {
                  resolve(false);
                }
              };
            }),
          name,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

/** Saves a few Markdown notes in this browser. */
async function saveNotes(app: App): Promise<void> {
  await app.goto('?doc=welcome');
  for (const file of [
    text('kitchen.md', '# Kitchen plan\n\nBuy new cabinets and a sink. #renovation #budget\n'),
    text('garden.md', '# Garden\n\nPlant roses along the fence in spring. #garden/spring\n'),
    text('taxes.md', '# Taxes\n\nCollect receipts for the budget review.\n'),
  ]) {
    await importFile(app, file);
    await waitForKept(app.page, file.name);
  }
}

test('Edit › Search All Documents finds documents by the words in them', async ({ app, page }) => {
  await saveNotes(app);
  await app.menu('Edit', 'Search All Documents');
  await expect(panel(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await input(page).fill('cabinets');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('kitchen.md');
  await expect(rows(page).first().locator('mark')).toHaveText('cabinets');
  // Every word has to be there, and a partly typed word counts.
  await input(page).fill('cabinets roses');
  await expect(panel(page).getByText('No document matches.')).toBeVisible();
  await input(page).fill('rose');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('garden.md');
});

test('a #tag finds the documents tagged with it, and the tags are listed to pick from', async ({ app, page }) => {
  await saveNotes(app);
  await page.keyboard.press(`${MOD}+Shift+f`);
  await expect(panel(page)).toBeVisible();
  // Before anything is typed: every tag, with how many documents use it.
  const chip = (name: string) => panel(page).locator('.wm-search-chip', { hasText: name });
  await expect(chip('#renovation')).toBeVisible();
  await expect(chip('#garden/spring')).toBeVisible();
  await chip('#budget').click();
  await expect(input(page)).toHaveValue('#budget');
  await expect(rows(page)).toHaveCount(1); // only kitchen.md uses the tag; taxes.md only has the word
  await expect(rows(page).first()).toContainText('kitchen.md');
  // A tag also finds the tags inside it.
  await input(page).fill('#garden');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('garden.md');
  // The word is not the tag.
  await input(page).fill('budget');
  await expect(rows(page)).toHaveCount(2);
});

test('choosing a result opens that document', async ({ app, page }) => {
  await saveNotes(app);
  await app.menu('Edit', 'Search All Documents');
  await input(page).fill('roses');
  await expect(rows(page)).toHaveCount(1);
  await input(page).press('Enter');
  await expect(panel(page)).toHaveCount(0);
  await app.ready();
  await expect.poll(() => app.text()).toContain('Plant roses along the fence');
});

test('the Documents screen finds documents by what is in them too', async ({ app, page }) => {
  await saveNotes(app);
  await app.menu('File', 'Open…');
  const dashboard = page.locator('.wm-dashboard');
  await dashboard.getByRole('searchbox', { name: 'Search documents' }).fill('cabinets');
  // The name matches at once; what is inside a document a moment later.
  await expect(dashboard.locator('article.wm-card')).toHaveCount(1);
  await expect(dashboard.locator('article.wm-card .wm-card-name')).toHaveText('kitchen.md');
});

test('quotes find a phrase in one paragraph, and a minus leaves documents out', async ({ app, page }) => {
  await saveNotes(app);
  await app.menu('Edit', 'Search All Documents');
  await input(page).fill('"new cabinets"');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('kitchen.md');
  await input(page).fill('"cabinets new"'); // the words are there, not in that order
  await expect(panel(page).getByText('No document matches.')).toBeVisible();
  // "budget" is a word in taxes.md and a tag in kitchen.md; the minus drops the document that has the tag.
  await input(page).fill('budget -#budget');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('taxes.md');
  await input(page).fill('budget -receipts');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('kitchen.md');
});
