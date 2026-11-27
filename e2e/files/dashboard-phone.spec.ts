// The Documents screen on a phone: a list by default (a row per folder and document with its whole name, and its commands in a ⋯
// menu), a heading in one row with Up beside the search, and the phone's Back going up a folder before it closes the screen.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { IPHONE, dropFile, text, waitForSaved } from './helpers';

test.use(IPHONE);

const LONG = 'Notes from the meeting with the architect about the kitchen.txt';
const screen = (page: Page) => page.getByRole('region', { name: 'Documents' });
const row = (page: Page, name: string) => screen(page).locator('.wm-card', { hasText: name });

async function openDocuments(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('dialog', { name: 'Menu' }).getByRole('menuitem', { name: /^Open/ }).first().click();
  await expect(screen(page)).toBeVisible();
}

async function addDocument(page: Page, name: string): Promise<void> {
  await dropFile(page, text(name, `${name}\n`), { x: 100, y: 400 });
  await waitForSaved(page);
}

test('it is a list, with each document’s whole name and its commands behind ⋯', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await addDocument(page, LONG);
  await openDocuments(page);
  await expect(screen(page).getByRole('radio', { name: 'List' })).toHaveAttribute('aria-checked', 'true');
  const title = row(page, 'Notes from').locator('.wm-card-title');
  // Nothing of the name is cut off: it wraps instead.
  await expect.poll(() => title.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(row(page, 'Notes from').locator('.wm-card-actions')).toBeHidden();

  const more = screen(page).getByRole('button', { name: `More for ${LONG}` });
  const box = (await more.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(40);
  await more.click();
  const menu = page.getByRole('menu');
  for (const name of ['Open', 'Rename', 'Move…', 'Delete']) await expect(menu.getByRole('menuitem', { name, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();

  // A tap on the row opens it.
  await row(page, 'Notes from').locator('.wm-card-open').click();
  await expect(screen(page)).toBeHidden();
  await expect.poll(() => page.title()).toContain('Notes from the meeting');
});

test('Grid is kept once chosen, and shows the size slider', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await openDocuments(page);
  await screen(page).getByRole('radio', { name: 'Grid' }).click();
  await expect(screen(page)).not.toHaveClass(/wm-dash-list/);
  await page.reload();
  await app.ready();
  await openDocuments(page);
  await expect(screen(page).getByRole('radio', { name: 'Grid' })).toHaveAttribute('aria-checked', 'true');
});

test('Up and the phone’s Back go up a folder, and Back at the top closes the screen', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await addDocument(page, 'Plan.md');
  await openDocuments(page);
  const up = screen(page).getByRole('button', { name: 'Up a level' });
  await expect(up).toBeHidden();
  for (const name of ['Outer', 'Inner']) {
    await screen(page).getByRole('button', { name: 'New folder' }).first().click();
    const field = screen(page).locator('.wm-card-name-input');
    await field.fill(name);
    await field.press('Enter');
    await row(page, name).locator('.wm-card-open').click();
    await expect(screen(page).locator('.wm-crumb[aria-current="page"]')).toHaveText(name);
  }
  await expect(up).toBeVisible();

  // The path stays at the top as the list scrolls.
  await expect(screen(page).locator('.wm-dash-crumbs')).toHaveCSS('position', 'sticky');

  await page.goBack();
  await expect(screen(page).locator('.wm-crumb[aria-current="page"]')).toHaveText('Outer');
  await up.click();
  await expect(up).toBeHidden();
  await expect(screen(page).locator('.wm-dash-crumbs')).toBeHidden();
  await expect(screen(page)).toBeVisible();
  await page.goBack();
  await expect(screen(page)).toBeHidden();
  await expect.poll(() => page.title()).toContain('Plan');
});

test('the Files sidebar lies over the document on a phone, and opening a document from it puts it away', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await addDocument(page, 'Plan.md');
  await addDocument(page, 'Second.md');
  await page.evaluate(() => (window as unknown as { golem: { commands: { run(id: string): Promise<unknown> } } }).golem.commands.run('view.filesPanel'));
  const sidebar = page.locator('.wm-files');
  await expect(sidebar).toBeVisible();
  // Over the document, not beside it: the document keeps the window's whole width.
  expect((await sidebar.boundingBox())!.width).toBeGreaterThan(300);
  expect((await page.locator('#viewport').boundingBox())!.width).toBe(page.viewportSize()!.width);
  await sidebar.locator('.wm-files-file', { hasText: 'Plan' }).click();
  await expect(sidebar).toBeHidden();
  await expect.poll(() => page.title()).toContain('Plan');
});
