// A document changed in the account by something other than this browser (another computer's vault folder, where an ai app may be
// working) while it is open here. Alone in its room, the open document hears of the save and puts it in place (accountSaved in
// client/src/main.ts); an edit here that couldn't be sent first is merged with it when the two changed different paragraphs
// (client/src/formats/merge.ts) and kept as a conflicted copy when they changed the same one. The other computer is played by saves
// straight to the document API.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { cloudParts, makeDocx, newPerson, openCloud, roomOf, statusLine, unzip, uploadDoc } from './helpers';
import { CLIENT_ORIGIN } from '../ports.ts';

/** The account's copy of a document, a paragraph per line. */
async function cloudText(page: Page, id: string): Promise<string> {
  const parts = await cloudParts(page, id);
  const docx = parts['document.docx'] ? unzip(parts['document.docx']) : parts;
  const xml = docx['word/document.xml']!.toString('utf8');
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((p) => [...p[0].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join('')).join('\n');
}

/** Saves `bytes` over the account's copy, as another computer would: on top of its current version. */
async function saveElsewhere(page: Page, id: string, bytes: Buffer): Promise<void> {
  const docs = (await (await page.request.get('/api/documents')).json()) as { id: string; updatedAt: number }[];
  const base = docs.find((d) => d.id === id)!.updatedAt;
  const response = await page.request.put(`/api/documents/${id}?base=${base}`, { data: bytes, headers: { origin: CLIENT_ORIGIN } });
  expect(response.status(), await response.text()).toBe(200);
}

/** Whether this browser's copy of cloud document `cloudId` has edits the account hasn't got (saved here, not sent). */
const savedUnsent = (page: Page, cloudId: string) =>
  page.evaluate(
    (id) =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open('word');
        open.onsuccess = () => {
          const all = open.result.transaction('meta').objectStore('meta').getAll();
          all.onsuccess = () => {
            const info = (all.result as { cloudId?: string; updatedAt: number; cloudSyncedAt?: number }[]).find((d) => d.cloudId === id);
            open.result.close();
            resolve(!!info && info.updatedAt > (info.cloudSyncedAt ?? 0));
          };
        };
      }),
    cloudId,
  );

const conflicted = async (page: Page) => ((await (await page.request.get('/api/documents')).json()) as { name: string }[]).map((d) => d.name).filter((n) => n.includes('conflicted'));

test('a change saved elsewhere shows in the document open here, and the next save here builds on it', async ({ browser }) => {
  const person = await newPerson(browser, 'outside-open');
  const { page } = person;
  const doc = await uploadDoc(page, 'Shopping.docx', await makeDocx(browser, ['Buy apples.']));
  const app = await openCloud(page, doc.id);
  await expect.poll(() => app.text()).toContain('Buy apples.');
  // Joined its room, alone, so it hears of the other computer's save.
  await expect.poll(async () => ((await roomOf(page)) as { mode?: string } | null)?.mode ?? null, { timeout: 15_000 }).toBe('solo');

  await saveElsewhere(page, doc.id, await makeDocx(browser, ['Buy pears.']));
  await expect.poll(() => app.text(), { timeout: 15_000 }).toContain('Buy pears.');

  await app.press('ControlOrMeta+End');
  await app.type(' And bread.');
  await expect.poll(() => cloudText(page, doc.id), { timeout: 30_000 }).toContain('Buy pears. And bread.');
  expect(await conflicted(page)).toEqual([]);
  await person.context.close();
});

test('edits made here and elsewhere at the same time, in different paragraphs, are merged instead of kept apart', async ({ browser }) => {
  const person = await newPerson(browser, 'outside-merge');
  const { page, context } = person;
  const doc = await uploadDoc(page, 'Plans.docx', await makeDocx(browser, ['First line.', 'Second line.', 'Last line.']));
  const app = await openCloud(page, doc.id);
  await expect.poll(() => app.text()).toContain('Last line.');

  // Offline, so this edit is saved here but can't be sent before the other computer's lands.
  await context.setOffline(true);
  await app.press('ControlOrMeta+End');
  await app.type(' Mine.');
  await expect.poll(() => savedUnsent(page, doc.id), { timeout: 15_000 }).toBe(true);
  await saveElsewhere(page, doc.id, await makeDocx(browser, ['First line, theirs.', 'Second line.', 'Last line.']));
  await context.setOffline(false);

  // The upload is refused (the account moved on), merged, and sent again: both are in the account and on screen.
  await expect.poll(() => statusLine(page), { timeout: 30_000 }).toContain('both sets of changes were kept');
  await expect.poll(() => cloudText(page, doc.id), { timeout: 30_000 }).toMatch(/First line, theirs\.[\s\S]*Last line\. Mine\./);
  await expect.poll(() => app.text(), { timeout: 15_000 }).toContain('First line, theirs.');
  expect(await app.text()).toContain('Last line. Mine.');
  expect(await conflicted(page)).toEqual([]);
  await person.context.close();
});

test('the same paragraph changed here and elsewhere is still kept as a conflicted copy', async ({ browser }) => {
  const person = await newPerson(browser, 'outside-conflict');
  const { page, context } = person;
  const doc = await uploadDoc(page, 'Plans.docx', await makeDocx(browser, ['Only line.']));
  const app = await openCloud(page, doc.id);
  await expect.poll(() => app.text()).toContain('Only line.');
  await context.setOffline(true);
  await app.press('ControlOrMeta+End');
  await app.type(' Mine.');
  await expect.poll(() => savedUnsent(page, doc.id), { timeout: 15_000 }).toBe(true);
  await saveElsewhere(page, doc.id, await makeDocx(browser, ['Only line, theirs.']));
  await context.setOffline(false);
  await expect.poll(() => conflicted(page), { timeout: 30_000 }).toEqual(['Plans (conflicted copy).docx']);
  // The other computer's version is untouched.
  expect(await cloudText(page, doc.id)).toContain('Only line, theirs.');
  await person.context.close();
});
