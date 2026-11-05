// The edit journal (docs/edit-journal.md) for someone signed in: what is typed just before a reload comes back and reaches the
// account, with no conflicted copy; and in a shared room, where the room holds the edits, nothing comes back twice.

import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { cloudDocs, cloudPair, expectText, newPerson, waitForCloudDoc } from './helpers';

const journalKeys = (page: Page): Promise<string[]> => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('golemdocs.journal.')));

test('edits made just before a reload come back, reach the account, and make no conflicted copy', async ({ browser }) => {
  const person = await newPerson(browser, 'journal');
  const { page, app } = person;
  await app.blank();
  await app.type('kept', 20);
  await waitForCloudDoc(page);
  await expect(page.locator('.wm-sync')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
  await expect.poll(() => journalKeys(page)).toEqual([]);

  await app.type(' more', 20);
  await expect.poll(() => journalKeys(page), { intervals: [10] }).not.toEqual([]);
  await page.reload();
  await app.ready();
  await expect.poll(() => app.text()).toBe('kept more');

  await expect.poll(() => journalKeys(page), { timeout: 15_000 }).toEqual([]);
  await expect(page.locator('.wm-sync')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
  expect((await cloudDocs(page)).map((d) => d.name)).toEqual(['Document1.docx']);
  // And it stays, with nothing left to bring back.
  await page.reload();
  await app.ready();
  await expect.poll(() => app.text()).toBe('kept more');
  await person.context.close();
});

test('in a shared room the room holds the edits: a reload brings nothing back twice', async ({ browser }) => {
  const { a, b } = await cloudPair(browser, ['Hello']);
  await a.app.type(' shared', 20);
  await expectText(b.app, 'Hello shared');
  expect(await journalKeys(a.page)).toEqual([]);
  await a.page.reload();
  await a.app.ready();
  await expectText(a.app, 'Hello shared');
  await a.page.waitForTimeout(1000);
  expect(await a.app.text()).toBe('Hello shared');
  expect(await b.app.text()).toBe('Hello shared');
  await b.context.close();
  await a.context.close();
});
