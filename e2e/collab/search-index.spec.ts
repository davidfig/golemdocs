// Search All Documents with an account: the server builds each document's search index on demand
// (GET /api/documents/:id/index) and another computer fetches it instead of downloading the .docx.

import type { Browser, BrowserContext, Page, Request } from '@playwright/test';
import { test, expect, App } from '../fixtures';
import { cloudDocs, newPerson, shareWith, signInAs, uploadDoc, waitForCloudDoc, waitSaved, makeDocx, type CloudDoc, type Person } from './helpers';

const panel = (page: Page) => page.locator('dialog.wm-search');
const input = (page: Page) => panel(page).getByRole('textbox', { name: 'Search words or #tags in every document' });
const rows = (page: Page) => panel(page).locator('.wm-search-row');

/** The account's document once its last upload has landed (its updatedAt has stopped changing). */
async function settledDoc(page: Page, id: string, after = 0): Promise<CloudDoc> {
  let last = -1;
  let found: CloudDoc | undefined;
  await expect
    .poll(async () => {
      found = (await cloudDocs(page)).find((d) => d.id === id);
      const stable = !!found && found.updatedAt > after && found.updatedAt === last;
      last = found?.updatedAt ?? -1;
      return stable;
    }, { timeout: 30_000, intervals: [700] })
    .toBe(true);
  return found!;
}

/** What the page asks the server for about documents, from now on. */
function watch(page: Page) {
  const calls: { url: string; method: string; status?: number; indexAt?: string | null }[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/documents/')) return;
    const request: Request = response.request();
    calls.push({ url: url.pathname, method: request.method(), status: response.status(), indexAt: response.headers()['x-index-at'] });
  });
  return {
    indexes: (id: string) => calls.filter((c) => c.method === 'GET' && c.url === `/api/documents/${id}/index`),
    files: (id: string) => calls.filter((c) => c.method === 'GET' && c.url === `/api/documents/${id}`),
  };
}

async function openPanel(app: App): Promise<void> {
  await app.menu('Edit', 'Search All Documents');
  await expect(panel(app.page)).toBeVisible();
  await expect(input(app.page)).toBeFocused();
}

async function closePanel(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
}

/** A second computer: a fresh browser profile signed in as `person`'s account, with nothing stored. */
async function anotherComputer(browser: Browser, person: Person): Promise<{ context: BrowserContext; page: Page; app: App }> {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  await signInAs(context, person.email);
  const page = await context.newPage();
  return { context, page, app: new App(page) };
}

/** Computer 1: a new document typed and saved to the account. */
async function firstComputer(browser: Browser, typed: string) {
  const one = await newPerson(browser, 'idx');
  await one.app.blank();
  await one.app.type(typed);
  await waitSaved(one.page);
  const doc = await settledDoc(one.page, (await waitForCloudDoc(one.page)).id);
  return { one, doc };
}

test.describe('search with the account index', () => {
  test('A: the account\'s own computer finds a document by its words and tags', async ({ browser }) => {
    const { one } = await firstComputer(browser, 'The zebrafish tank needs cleaning #aquarium ok');
    await openPanel(one.app);
    await input(one.page).fill('zebrafish');
    await expect(rows(one.page)).toHaveCount(1);
    await expect(rows(one.page).first().locator('mark')).toHaveText('zebrafish');
    await input(one.page).fill('#aquarium');
    await expect(rows(one.page)).toHaveCount(1);
    await one.context.close();
  });

  test('B: another computer fetches the index and never downloads the document', async ({ browser }) => {
    const { one, doc } = await firstComputer(browser, 'The zebrafish tank needs cleaning #aquarium ok');
    const two = await anotherComputer(browser, one);
    const seen = watch(two.page);
    await two.app.goto('?doc=welcome');
    await openPanel(two.app);
    await input(two.page).fill('zebrafish');
    await expect(rows(two.page)).toHaveCount(1);
    await expect(rows(two.page).first()).toContainText('Document1');
    await input(two.page).fill('#aquarium');
    await expect(rows(two.page)).toHaveCount(1);

    const indexes = seen.indexes(doc.id);
    expect(indexes.length).toBeGreaterThanOrEqual(1);
    expect(indexes.map((c) => c.status)).toEqual(indexes.map(() => 200));
    const current = (await cloudDocs(two.page)).find((d) => d.id === doc.id)!;
    expect(indexes.at(-1)!.indexAt).toBe(String(current.updatedAt));
    expect(current.updatedAt).toBe(doc.updatedAt);
    expect(seen.files(doc.id)).toEqual([]); // the .docx itself was not downloaded
    await one.context.close();
    await two.context.close();
  });

  test('C: after an edit the index is rebuilt for the new version and the old words stop matching', async ({ browser }) => {
    const { one, doc } = await firstComputer(browser, 'The zebrafish tank needs cleaning');
    const two = await anotherComputer(browser, one);
    const seen = watch(two.page);
    await two.app.goto('?doc=welcome');
    await openPanel(two.app);
    await input(two.page).fill('zebrafish');
    await expect(rows(two.page)).toHaveCount(1);
    expect(seen.indexes(doc.id)).toHaveLength(1);
    await closePanel(two.page);

    // Computer 1 edits: the zebrafish words become other ones.
    await one.app.focus();
    await one.page.keyboard.press('ControlOrMeta+a');
    await one.app.type('Now it is about narwhals instead');
    const edited = await settledDoc(one.page, doc.id, doc.updatedAt);
    expect(edited.updatedAt).toBeGreaterThan(doc.updatedAt);

    // The second computer's page reads the library again when the panel is next opened.
    await two.page.reload();
    await two.app.ready();
    await openPanel(two.app);
    await input(two.page).fill('narwhals');
    await expect(rows(two.page)).toHaveCount(1);
    await input(two.page).fill('zebrafish');
    await expect(panel(two.page).getByText('No document matches.')).toBeVisible();
    const indexes = seen.indexes(doc.id);
    expect(indexes.length).toBeGreaterThanOrEqual(2);
    expect(indexes.at(-1)!.indexAt).toBe(String(edited.updatedAt));
    expect(indexes[0]!.indexAt).toBe(String(doc.updatedAt));
    expect(seen.files(doc.id)).toEqual([]);
    await one.context.close();
    await two.context.close();
  });

  // The same as B and C, with plain .docx files put in the account through the API (so what the
  // server reads is not the app's own wrapper format), to tell the index machinery from the file format.
  test('E: a plain .docx is indexed by the server; a new version gets a new index and the old words stop matching', async ({ browser }) => {
    const one = await newPerson(browser, 'plain');
    await one.page.goto('/?doc=welcome');
    const doc = await uploadDoc(one.page, 'Fish.docx', await makeDocx(browser, ['The zebrafish tank needs cleaning #aquarium']));
    const two = await anotherComputer(browser, one);
    const seen = watch(two.page);
    await two.app.goto('?doc=welcome');
    await openPanel(two.app);
    await input(two.page).fill('zebrafish');
    await expect(rows(two.page)).toHaveCount(1);
    await input(two.page).fill('#aquarium');
    await expect(rows(two.page)).toHaveCount(1);
    expect(seen.indexes(doc.id).map((c) => [c.status, c.indexAt])).toEqual([[200, String(doc.updatedAt)]]);
    expect(seen.files(doc.id)).toEqual([]);
    await closePanel(two.page);

    const response = await one.page.request.put(`/api/documents/${doc.id}?base=${doc.updatedAt}`, {
      data: await makeDocx(browser, ['Now it is about narwhals instead']),
      headers: { origin: new URL(one.page.url()).origin },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const next = (await response.json()) as CloudDoc;
    expect(next.updatedAt).toBeGreaterThan(doc.updatedAt);
    await two.page.reload();
    await two.app.ready();
    await openPanel(two.app);
    await input(two.page).fill('narwhals');
    await expect(rows(two.page)).toHaveCount(1);
    await input(two.page).fill('zebrafish');
    await expect(panel(two.page).getByText('No document matches.')).toBeVisible();
    expect(seen.indexes(doc.id).map((c) => [c.status, c.indexAt])).toEqual([
      [200, String(doc.updatedAt)],
      [200, String(next.updatedAt)],
    ]);
    expect(seen.files(doc.id)).toEqual([]);
    await one.context.close();
    await two.context.close();
  });

  test('D: a document shared with a viewer is found by the viewer', async ({ browser }) => {
    const owner = await newPerson(browser, 'owner');
    const viewer = await newPerson(browser, 'viewer');
    await viewer.page.goto('/?doc=welcome'); // known to the server, so the owner can share with them
    const doc = await uploadDoc(owner.page, 'Aquarium.docx', await makeDocx(browser, ['Feeding the zebrafish twice a day #aquarium']));
    await owner.page.goto('/?doc=welcome'); // the API checks the request's origin
    await shareWith(owner.page, doc.id, viewer.email, 'viewer');
    const seen = watch(viewer.page);
    await viewer.app.goto('?doc=welcome');
    await openPanel(viewer.app);
    await input(viewer.page).fill('zebrafish');
    await expect(rows(viewer.page)).toHaveCount(1);
    await expect(rows(viewer.page).first()).toContainText('Aquarium.docx');
    await input(viewer.page).fill('#aquarium');
    await expect(rows(viewer.page)).toHaveCount(1);
    expect(seen.indexes(doc.id).some((c) => c.status === 200)).toBe(true);
    await owner.context.close();
    await viewer.context.close();
  });
});
