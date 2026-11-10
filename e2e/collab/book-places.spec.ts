// Where a book is being read follows the person from device to device (src/reading.ts, server/src/reading.ts): a book
// opened on another computer opens where it was left on the first, and the latest reading wins wherever it was.

import type { Browser, Page } from '@playwright/test';
import { test, expect, App } from '../fixtures';
import { newPerson, signInAs } from './helpers';
import { buildEpub, importFile } from '../files/helpers';

/** The page in view, from the status bar. */
async function pageInView(page: Page): Promise<number> {
  const match = /Page (\d+) of (\d+)/.exec((await page.locator('.wm-footer-items').textContent()) ?? '');
  return match ? Number(match[1]) : 0;
}

/** The page of the place the account keeps for the one book this browser has read. */
async function pageInAccount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const rows = JSON.parse(localStorage.getItem('golemdocs.reading') ?? '[]') as [string, unknown][];
    if (!rows.length) return 0;
    const body = (await (await fetch(`/api/reading?book=${rows[0][0]}`)).json()) as { place: string | null };
    return body.place ? (JSON.parse(body.place) as { page: number }).page : 0;
  });
}

async function anotherDevice(browser: Browser, email: string) {
  const context = await browser.newContext();
  await signInAs(context, email);
  const page = await context.newPage();
  const app = new App(page);
  await page.goto('/?doc=welcome');
  await app.ready();
  return { context, page, app };
}

test('a book opens on another device where it was left, and going back on that one moves the first back too', async ({ browser }) => {
  const first = await newPerson(browser, 'reader');
  await first.page.goto('/?doc=welcome');
  await first.app.ready();
  await importFile(first.app, buildEpub());
  await first.app.press('PageDown', 7);
  await expect.poll(() => pageInView(first.page)).toBe(8);
  // Sent a few seconds after the reading settles.
  await expect.poll(() => pageInAccount(first.page), { timeout: 20_000 }).toBe(8);

  // The same book on another computer (its own copy of the file): it opens on page 8, and says why.
  const second = await anotherDevice(browser, first.email);
  await importFile(second.app, buildEpub());
  await expect.poll(() => pageInView(second.page), { timeout: 15_000 }).toBe(8);
  await expect(second.page.locator('.wm-toast')).toContainText('another device');

  // Back a few pages there, to reread: that is now the latest reading.
  await second.app.press('PageUp', 5);
  await expect.poll(() => pageInView(second.page)).toBe(3);
  await expect.poll(() => pageInAccount(second.page), { timeout: 20_000 }).toBe(3);

  // The first computer, opening the book again, goes back with it.
  await first.page.reload();
  await first.app.ready();
  await expect.poll(() => pageInView(first.page), { timeout: 15_000 }).toBe(3);

  await second.context.close();
  await first.context.close();
});
