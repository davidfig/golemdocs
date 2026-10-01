// Opening documents that are not there, or that need an account: the error paths of
// ?doc=cloud:…, ?doc=shared:…, ?doc=local:… and ?room=…

import { test, expect, App } from '../fixtures';
import { newPerson, signedOutContext, statusLine, uploadDoc, makeDocx } from './helpers';

const MISSING = '00000000-0000-4000-8000-000000000000';
const signInDialog = (page: import('@playwright/test').Page) => page.locator('dialog[open]').filter({ hasText: 'Not now' });

test.describe('cloud documents', () => {
  test('one that does not exist is reported, and the app stays usable', async ({ browser }) => {
    const person = await newPerson(browser, 'err');
    await person.page.goto(`/?doc=cloud:${MISSING}`);
    await person.app.ready().catch(() => undefined);
    await expect.poll(() => statusLine(person.page)).toContain('Couldn’t open the document');
    await person.context.close();
  });

  test('signed out, opening one asks you to sign in and comes back to it afterwards', async ({ browser }) => {
    const context = await signedOutContext(browser);
    const page = await context.newPage();
    await page.goto(`/?doc=cloud:${MISSING}`);
    const dialog = signInDialog(page);
    await expect(dialog).toBeVisible();
    const dev = dialog.getByRole('link', { name: /^Continue with Dev User/ });
    const back = new URL((await dev.getAttribute('href'))!, 'http://x').searchParams.get('return');
    expect(decodeURIComponent(back!)).toBe(`/?doc=cloud:${MISSING}`);
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toHaveCount(0);
    await context.close();
  });

  test('a real one, signed in, opens with its text', async ({ browser }) => {
    const person = await newPerson(browser, 'err');
    const doc = await uploadDoc(person.page, 'Real.docx', await makeDocx(browser, ['real text']));
    await person.page.goto(`/?doc=cloud:${doc.id}`);
    await person.app.ready();
    await expect.poll(() => person.app.text()).toBe('real text');
    await person.context.close();
  });
});

test.describe('shared documents', () => {
  test('signed out, opening a shared link asks you to sign in and comes back to it', async ({ browser }) => {
    const context = await signedOutContext(browser);
    const page = await context.newPage();
    await page.goto(`/?doc=shared:${MISSING}`);
    const dialog = signInDialog(page);
    await expect(dialog).toBeVisible();
    const dev = dialog.getByRole('link', { name: /^Continue with Dev User/ });
    expect(decodeURIComponent(new URL((await dev.getAttribute('href'))!, 'http://x').searchParams.get('return')!)).toBe(`/?doc=shared:${MISSING}`);
    await context.close();
  });

  test('one that is not shared with you says so and opens a blank document', async ({ browser }) => {
    const person = await newPerson(browser, 'err');
    await person.page.goto(`/?doc=shared:${MISSING}`);
    await person.app.ready();
    await expect.poll(() => statusLine(person.page)).toContain('no longer shared with you');
    await person.app.focus();
    await person.app.type('still editable');
    expect(await person.app.text()).toBe('still editable');
    await person.context.close();
  });

  test('a malformed id is treated as not shared', async ({ browser }) => {
    const person = await newPerson(browser, 'err');
    await person.page.goto('/?doc=shared:not-a-uuid');
    await person.app.ready();
    await expect.poll(() => statusLine(person.page)).toMatch(/no longer shared with you|Couldn’t open the shared document/);
    await person.context.close();
  });
});

test.describe('local documents', () => {
  test('one that is not in this browser says so and opens a blank document', async ({ browser }) => {
    const context = await signedOutContext(browser);
    const page = await context.newPage();
    const app = new App(page);
    await page.goto('/?doc=local:does-not-exist');
    await app.ready();
    await expect.poll(() => statusLine(page)).toContain('no longer saved in this browser');
    await app.type('fresh start');
    expect(await app.text()).toBe('fresh start');
    await context.close();
  });
});

test.describe('rooms', () => {
  test('?room= with no document opens a blank one, named by ?name=', async ({ browser }) => {
    const context = await signedOutContext(browser);
    const page = await context.newPage();
    const app = new App(page);
    await page.goto('/?room=brandnew&name=Minutes.docx');
    await app.ready();
    await expect.poll(() => statusLine(page)).toContain('Minutes.docx');
    await app.type('first in the room');
    expect(await app.text()).toBe('first in the room');
    await context.close();
  });

  test('a link to a room keeps the room in the address and does not save a local copy in the address bar', async ({ browser }) => {
    const context = await signedOutContext(browser);
    const page = await context.newPage();
    const app = new App(page);
    await page.goto('/?room=keepme');
    await app.ready();
    await app.type('typing');
    await expect(page).toHaveURL(/\?room=keepme/);
    expect(new URL(page.url()).searchParams.has('doc')).toBe(false);
    await context.close();
  });
});
