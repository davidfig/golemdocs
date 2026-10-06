// #tags typed in a document: Ctrl/Cmd+click on one opens Search All Documents on it.

import type { Page } from '@playwright/test';
import { test, expect } from '../files/fixtures';
import { importFile, text } from '../files/helpers';
import { IS_MAC, clickAt, lineGaps } from './helpers';

const panel = (page: Page) => page.locator('dialog.wm-search');
const input = (page: Page) => panel(page).getByRole('textbox', { name: 'Search words or #tags in every document' });
const rows = (page: Page) => panel(page).locator('.wm-search-row');

test('Ctrl/Cmd+click on a #tag opens Search All Documents on it, listing only the tagged documents; Escape returns to the editor', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  const other = text('other.md', '# Other\n\nNothing tagged in here.\n');
  await importFile(app, other);
  await expect(page.locator('.wm-sync')).toHaveAttribute('data-local', 'saved', { timeout: 15_000 });
  await expect(page).toHaveURL(/\?doc=local%3A/);
  await app.menu('File', 'New');
  await app.focus();
  const typed = 'Plan #project now';
  await app.type(typed);
  await expect(page.locator('.wm-sync')).toHaveAttribute('data-local', 'saved', { timeout: 15_000 });
  const gaps = await lineGaps(app, typed.length);
  // A plain click only places the caret.
  await clickAt(app, gaps[9]);
  await expect(panel(page)).toHaveCount(0);
  await page.waitForTimeout(600); // not a double click
  // "Plan " is 5 characters; the tag is the next 8 (the shortcut keeps the text): click inside it.
  await clickAt(app, gaps[9], { modifiers: [IS_MAC ? 'Meta' : 'Control'] });
  await expect(panel(page)).toBeVisible();
  await expect(input(page)).toHaveValue('#project');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).not.toContainText('other.md');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  // The keyboard is back in the document.
  await expect(app.editor).toBeFocused();
  // Chrome drops text typed in the same instant focus comes back from a closed dialog (no beforeinput is sent): let it settle, as a person's typing would.
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await expect.poll(() => app.text()).toBe('Plan #project now!');
});
