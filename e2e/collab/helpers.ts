// Helpers for the collaboration, sharing and account tests.
//
// Who is "signed in" in these tests: the API runs in wrangler's local mode with `DEV_USER` set, so a
// browser with no session cookie is automatically signed in as DEV_USER (`e2e@example.com`), a
// single account every test file shares. Tests that store documents in the account or share them
// therefore sign in as a fresh, unique account instead (`signInAs`): the dev provider's
// `/api/auth/start/dev?as=<email>` route creates a real session cookie for any email, so two
// browser contexts can be two different people, and nothing leaks between tests.
//
// A *signed-out* browser: signing out sets the `dev_signed_out` cookie, which stops the DEV_USER
// shortcut (server/src/auth.ts). `signedOutContext` sets that cookie up front (equivalent to having
// clicked Sign out), so `/api/auth/me` answers `{ user: null }` and the app behaves as a guest.
//
// Real-time collaboration: cloud documents join a Durable Object room on the server. Two browser
// contexts are two devices of one account (`cloudPair`, `secondDevice`), or two accounts, one
// sharing the document with the other.

import { inflateRawSync } from 'node:zlib';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { App, expect } from '../fixtures';
import { CLIENT_ORIGIN } from '../ports.ts';
import { buildZip } from '../files/helpers';

export interface Person {
  context: BrowserContext;
  page: Page;
  app: App;
  email: string;
  /** The display name the server gives this account (the email's local part). */
  name: string;
}

let counter = 0;
export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${counter}@example.com`;
}

export const nameOf = (email: string): string => email.split('@')[0]!;

/** Signs the context in as `email` (a dev-provider session; the account is created on first use). */
export async function signInAs(context: BrowserContext, email: string): Promise<void> {
  const response = await context.request.get(`/api/auth/start/dev?as=${encodeURIComponent(email)}`, { maxRedirects: 0 });
  expect(response.status()).toBe(302);
}

/** Signs the context out, as File/Sign out does (the dev-user shortcut stops applying). */
export async function signOutContext(context: BrowserContext, baseURL = CLIENT_ORIGIN): Promise<void> {
  await context.addCookies([{ name: 'dev_signed_out', value: '1', url: baseURL }]);
}

/** A new browser context that is a guest: nobody signed in. */
export async function signedOutContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  await signOutContext(context);
  return context;
}

/** A new browser context signed in as a fresh, unique account. */
export async function newPerson(browser: Browser, prefix = 'user'): Promise<Person> {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const email = uniqueEmail(prefix);
  await signInAs(context, email);
  const page = await context.newPage();
  return { context, page, app: new App(page), email, name: nameOf(email) };
}

export interface CloudDoc {
  id: string;
  name: string;
  role: string;
  size: number;
  updatedAt: number;
}

export async function cloudDocs(page: Page): Promise<CloudDoc[]> {
  const response = await page.request.get('/api/documents');
  // A failure (the server restarting, say) reads as "nothing yet", so polling callers try again.
  return response.ok() ? ((await response.json()) as CloudDoc[]) : [];
}

/** Waits until the account holds a document (the app uploads what you type), and returns it. */
export async function waitForCloudDoc(page: Page, pick: (docs: CloudDoc[]) => CloudDoc | undefined = (docs) => docs[0]): Promise<CloudDoc> {
  let found: CloudDoc | undefined;
  await expect
    .poll(async () => (found = pick(await cloudDocs(page))), { timeout: 30_000, message: 'the document reaches the account' })
    .toBeTruthy();
  return found!;
}

/**
 * Waits until the account's copy of a document holds comments with all of `texts`: proof that
 * the last edit was saved (locally first, then uploaded). The save indicator alone can still show
 * the previous save for a moment after an edit.
 */
export async function waitForCloudComments(page: Page, id: string, texts: string[], options: { resolved?: boolean } = {}): Promise<void> {
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/documents/${id}`);
      if (!response.ok()) return false;
      let parts = unzip(Buffer.from(await response.body()));
      if (parts['document.docx']) parts = unzip(parts['document.docx']); // the app's own wrapper around the .docx
      const comments = parts['word/comments.xml']?.toString() ?? '';
      const resolved = !options.resolved || (parts['word/commentsExtended.xml']?.toString() ?? '').includes('w15:done="1"');
      return resolved && texts.every((t) => comments.includes(t));
    }, { timeout: 30_000, message: 'the comments reach the account' })
    .toBe(true);
}

/** Shares a cloud document from `owner` with `email` (who must have signed in once). */
export async function shareWith(owner: Page, docId: string, email: string, role: 'editor' | 'viewer'): Promise<void> {
  const response = await owner.request.put(`/api/documents/${docId}/shares`, {
    data: { email, role },
    headers: { origin: new URL(owner.url()).origin },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

/** The window hooks main.ts exposes. */
export const others = (page: Page) =>
  page.evaluate(() => (window as unknown as { selectionState: { others: { name: string; color: number; x: number; y: number; page: number; height: number }[] } }).selectionState.others);

export const statusLine = (page: Page): Promise<string> => page.evaluate(() => (window as unknown as { status: string }).status);

/** The text of a document, polled until it equals `expected`. */
export async function expectText(app: App, expected: string): Promise<void> {
  await expect.poll(() => app.text(), { message: `document text is ${JSON.stringify(expected)}` }).toBe(expected);
}

/** A closer for several browser contexts at once, so a test written for one context can end with `context.close()`. */
export const together = (...contexts: BrowserContext[]) => ({ close: async () => void (await Promise.all(contexts.map((c) => c.close()))) });

/**
 * A second device of the account `person` is signed in as, opened on the cloud document `person` has open (it must have reached the
 * account) and in its room with it. `context` closes both devices.
 */
export async function secondDevice(browser: Browser, person: Person): Promise<{ context: ReturnType<typeof together>; a: App; b: App }> {
  const doc = await waitForCloudDoc(person.page);
  const other = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  await signInAs(other, person.email);
  const b = await openCloud(await other.newPage(), doc.id);
  await expect.poll(() => statusLine(person.page), { message: 'the second device joined the room', timeout: 30_000 }).toContain('2 people here');
  return { context: together(person.context, other), a: person.app, b };
}

/** Two devices in one cloud text document, which starts with `initial` (the first device's caret at its end). */
export async function roomPair(browser: Browser, initial = 'Hello'): Promise<{ context: ReturnType<typeof together> & { newPage(): Promise<Page> }; a: App; b: App; url: string }> {
  const pair = await cloudPair(browser, [initial]);
  const contexts = [pair.a.context, pair.b.context];
  const context = {
    // Another device of the account: a context of its own, as a tab of an existing one would not be a separate device.
    newPage: async () => {
      const other = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
      contexts.push(other);
      await signInAs(other, pair.a.email);
      return other.newPage();
    },
    close: async () => void (await Promise.all(contexts.map((c) => c.close()))),
  };
  return { context, a: pair.a.app, b: pair.b.app, url: `/?doc=cloud:${pair.doc.id}` };
}

// --- Comments ---------------------------------------------------------------------------

/** Selects `count` characters from the caret with Shift+Right (the caret must be where the selection starts). */
export async function selectForward(app: App, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await app.page.keyboard.press('Shift+ArrowRight');
}

/**
 * The draft box of a new comment, once Insert ▸ Comment has opened it. The app hands the keyboard
 * back to the document shortly after opening it (see the fixme in comments.spec.ts), so this keeps
 * focusing the box until the focus sticks, which also works once that is fixed.
 */
export async function openDraft(app: App): Promise<Locator> {
  await app.menu('Insert', 'Comment');
  const box = app.page.locator('.wm-comment-draft textarea');
  await expect(box).toBeVisible();
  await expect(async () => {
    await box.focus();
    await app.page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
    expect(await box.evaluate((el) => el === document.activeElement)).toBe(true);
  }).toPass();
  return box;
}

/**
 * Insert ▸ Comment on the current selection, writes `text` in the new card and sends it with the
 * Reply button.
 */
export async function addComment(app: App, text: string): Promise<void> {
  const before = await app.page.locator('.wm-comments .wm-comment:not(.wm-comment-draft)').count();
  const box = await openDraft(app);
  await box.fill(text);
  await app.page.locator('.wm-comment-draft').getByRole('button', { name: 'Reply' }).click();
  await expect(app.page.locator('.wm-comments .wm-comment:not(.wm-comment-draft)')).toHaveCount(before + 1);
}

/** A blank document holding "alpha beta gamma", with a comment on "alpha" (and on "gamma" if `two`). */
export async function documentWithComments(app: App, two = false): Promise<void> {
  await app.blank();
  await app.type('alpha beta gamma');
  await app.press('Home');
  await selectForward(app, 5);
  await addComment(app, 'note on alpha');
  if (two) {
    await app.press('End');
    for (let i = 0; i < 5; i++) await app.page.keyboard.press('Shift+ArrowLeft');
    await addComment(app, 'note on gamma');
  }
}

/** The text of every comment card's first entry, in panel order. */
export const commentTexts = (page: Page): Promise<string[]> =>
  page.locator('.wm-comments .wm-comment:not(.wm-comment-draft)').evaluateAll((cards) => cards.map((c) => c.querySelector('.wm-comment-entry p')?.textContent ?? ''));

export const commentsTitle = (page: Page) => page.locator('.wm-comments-bar h2');

/**
 * Waits until the save indicator says the open document is saved to the account, and the account
 * holds a document. (The indicator can show the previous save for a moment after an edit, so tests
 * that must be sure of a particular edit check the account's copy instead: waitForCloudComments.)
 */
export async function waitSaved(page: Page): Promise<void> {
  await expect(page.locator('.wm-sync')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
  await waitForCloudDoc(page);
}

// --- Files -------------------------------------------------------------------------------

/** The entries of a zip file (.docx), inflated; enough of the format for files the app writes. */
export function unzip(buffer: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  let end = buffer.length - 22;
  while (end > 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    out[name] = method === 0 ? data : inflateRawSync(data);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** File ▸ Import…, choosing a file made from `content`. */
export async function openFile(app: App, name: string, content: Buffer | string, mimeType = 'application/octet-stream'): Promise<void> {
  const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), app.menu('File', 'Import')]);
  await chooser.setFiles({ name, mimeType, buffer: Buffer.isBuffer(content) ? content : Buffer.from(content) });
  await app.page.waitForFunction(() => (window as unknown as { loaded: boolean }).loaded === true);
}

// --- Cloud rooms -----------------------------------------------------------------------------

export interface CloudPair {
  /** The account's first device (where the document was made). */
  a: Person;
  /** A second device of the same account, opened on the cloud copy. */
  b: { context: BrowserContext; page: Page; app: App };
  doc: CloudDoc;
}

/** A .docx made by the app (in a throwaway guest session, so nothing is uploaded) holding `paragraphs`. */
const docxCache = new Map<string, Promise<Buffer>>();
export function makeDocx(browser: Browser, paragraphs: string[]): Promise<Buffer> {
  // Cached per worker: the same few documents are needed by many tests.
  const key = JSON.stringify(paragraphs);
  if (!docxCache.has(key)) docxCache.set(key, buildDocx(browser, paragraphs));
  return docxCache.get(key)!;
}

async function buildDocx(browser: Browser, paragraphs: string[]): Promise<Buffer> {
  const context = await signedOutContext(browser);
  const app = new App(await context.newPage());
  await app.blank();
  for (const [i, text] of paragraphs.entries()) {
    if (i > 0) await app.press('Enter');
    await app.type(text);
  }
  const file = await app.download(() => app.menu('File', 'Download'));
  await context.close();
  return file.bytes;
}

/** Puts `bytes` in the signed-in account of `page` as a new cloud document. */
export async function uploadDoc(page: Page, name: string, bytes: Buffer): Promise<CloudDoc> {
  const response = await page.request.post(`/api/documents?name=${encodeURIComponent(name)}`, {
    data: bytes,
    headers: { origin: new URL(page.url() === 'about:blank' ? CLIENT_ORIGIN : page.url()).origin },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as CloudDoc;
}

/** Opens a cloud document (`?doc=cloud:<id>`) on a page of the signed-in account. */
export async function openCloud(page: Page, id: string): Promise<App> {
  const app = new App(page);
  await page.goto(`/?doc=cloud:${id}`);
  await app.ready();
  return app;
}

/**
 * One account on two devices (browser contexts), both in the server's room for a cloud document
 * that starts with `paragraphs`. Both sides are the same account, so they show up to each other
 * under the same name.
 */
export async function cloudPair(browser: Browser, paragraphs: string[] = ['Hello'], file: { name: string; wrap?: (docx: Buffer) => Buffer } = { name: 'Shared.docx' }): Promise<CloudPair> {
  const a = await newPerson(browser, 'room');
  const docx = await makeDocx(browser, paragraphs);
  const doc = await uploadDoc(a.page, file.name, file.wrap ? file.wrap(docx) : docx);
  const b = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  await signInAs(b, a.email);
  const page = await b.newPage();
  const appA = await openCloud(a.page, doc.id);
  const appB = await openCloud(page, doc.id);
  // Carets are what people see of each other, so each puts theirs in the text.
  for (const app of [appA, appB]) {
    await app.focus();
    await app.press('ControlOrMeta+End');
  }
  // A room that has just been woken (the first one after the server starts, or on a busy machine) can take a while.
  await expect.poll(async () => (await others(a.page)).length, { message: 'the second device joined the room', timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await others(page)).length, { timeout: 30_000 }).toBe(1);
  return { a, b: { context: b, page, app: appB }, doc };
}

/** Waits for the status line to say how many people are in the room. */
export async function expectPeople(page: Page, count: number): Promise<void> {
  await expect.poll(() => statusLine(page), { message: `${count} people in the room` }).toContain(`${count} people here`);
}

/** A stored Markdown document (the app's .wdoc: the document, with that it is edited as Markdown and its front matter) around a .docx. */
export function markdownWdoc(docx: Buffer, frontMatter: string): Buffer {
  return buildZip([
    { name: 'mimetype', data: 'application/x-golem-document', store: true },
    { name: 'manifest.json', data: JSON.stringify({ version: 1, lens: 'md', origin: 'md', pagesCurrent: false }) },
    { name: 'document.docx', data: docx, store: true },
    { name: 'extensions/md.json', data: JSON.stringify({ frontMatter }) },
  ]);
}

/** The cloud copy of a document, as the account stores it: the entries of the .wdoc (or of a plain .docx, which has others). */
export async function cloudParts(page: Page, id: string): Promise<Record<string, Buffer>> {
  const response = await page.request.get(`/api/documents/${id}`);
  expect(response.ok()).toBe(true);
  return unzip(Buffer.from(await response.body()));
}
