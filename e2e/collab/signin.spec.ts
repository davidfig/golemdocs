// Sign-in state: what a guest sees, the sign-in dialog, signing in and out, and what signing out
// and Clear Local Data do to what is kept in the browser. See helpers.ts for how a guest (signed-out)
// browser is made against the dev server.

import { test, expect, App } from '../fixtures';
import { newPerson, signedOutContext, statusLine, waitSaved, waitForCloudDoc } from './helpers';
import { waitForSaved } from '../files/helpers';
import type { Page } from '@playwright/test';

const signInDialog = (page: Page) => page.locator('dialog[open]').filter({ hasText: 'Not now' });
const me = (page: Page) => page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { user: { email: string } | null }).user);

async function guest(browser: import('@playwright/test').Browser) {
  const context = await signedOutContext(browser);
  const page = await context.newPage();
  return { context, page, app: new App(page) };
}

/** The save indicator's panel (how the open document is saved). */
async function openSyncPanel(page: Page) {
  await page.locator('.wm-sync').click();
  return page.locator('.wm-sync-panel');
}

/** The person icon's panel: who is signed in, Sign in / Sign out. */
async function openAccountPanel(page: Page) {
  await page.locator('.wm-account').click();
  return page.locator('.wm-sync-panel');
}

test.describe('a guest (not signed in)', () => {
  test('the server reports nobody signed in; the save indicator says it is saved in this browser and the account menu offers to sign in', async ({ browser }) => {
    const { context, page, app } = await guest(browser);
    await app.blank();
    await app.type('text');
    expect(await me(page)).toBeNull();
    const button = page.locator('.wm-sync');
    await expect(button).toHaveAttribute('data-state', 'guest');
    await expect(button).toHaveAttribute('data-local', 'saved', { timeout: 15_000 });
    await expect(page.locator('.wm-account')).toHaveAttribute('data-signed-in', 'false');
    let panel = await openSyncPanel(page);
    await expect(panel).toContainText('Saved locally');
    await expect(panel).toContainText('isn’t uploaded anywhere');
    await expect(panel.getByRole('button', { name: 'Sign in…' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    panel = await openAccountPanel(page);
    await expect(panel).toContainText('Not signed in');
    await expect(panel.getByRole('button', { name: 'Sign in…' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await context.close();
  });

  test('a guest still edits and the document is kept in this browser', async ({ browser }) => {
    const { context, page, app } = await guest(browser);
    await app.blank();
    await app.type('kept locally');
    await expect(page).toHaveURL(/\?doc=local%3A/, { timeout: 15_000 });
    await waitForSaved(page); // a reload before the autosave has run would lose the typing
    await page.reload();
    await app.ready();
    await expect.poll(() => app.text()).toBe('kept locally');
    // Nothing went to an account.
    expect((await page.request.get('/api/documents')).status()).toBe(401);
    await context.close();
  });

  test('cloud endpoints refuse a guest with 401', async ({ browser }) => {
    const { context, page, app } = await guest(browser);
    await app.goto('?doc=welcome');
    for (const path of ['/api/documents', '/api/shared', '/api/subscription']) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(401);
      expect(await response.json()).toEqual({ error: 'not signed in' });
    }
    await context.close();
  });

  test('File > Share for a guest offers a link but says to sign in to share with people', async ({ browser }) => {
    const { context, page, app } = await guest(browser);
    await app.blank();
    await app.type('text');
    await app.menu('File', 'Share');
    const dialog = page.locator('dialog.wm-share');
    await expect(dialog.getByRole('button', { name: 'Get Link' })).toBeVisible();
    await expect(dialog.getByText('Sign in to share this document')).toBeVisible();
    await expect(dialog.getByLabel('Email address')).toHaveCount(0);
    await context.close();
  });

  test('the dashboard lists what is saved in this browser, with no account controls', async ({ browser }) => {
    const { context, page, app } = await guest(browser);
    await app.blank();
    await app.type('listed');
    await expect(page).toHaveURL(/\?doc=local%3A/, { timeout: 15_000 });
    await app.menu('File', 'Open');
    const dashboard = page.locator('.wm-dashboard');
    await expect(dashboard).toBeVisible();
    await expect(dashboard.getByText(/Document1/).first()).toBeVisible();
    await expect(dashboard.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
    await expect(dashboard.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await context.close();
  });
});

test.describe('the sign-in dialog', () => {
  test('lists the providers as links that come back to the open document', async ({ browser }) => {
    const { context, page, app } = await guest(browser);
    await app.blank();
    await app.type('before signing in');
    const panel = await openAccountPanel(page);
    await panel.getByRole('button', { name: 'Sign in…' }).click();
    const dialog = signInDialog(page);
    await expect(dialog.getByText('Sign in to subscribe to sync, share documents')).toBeVisible();
    const google = dialog.getByRole('link', { name: 'Continue with Google' });
    const dev = dialog.getByRole('link', { name: /^Continue with Dev User/ });
    await expect(google).toBeVisible();
    await expect(dev).toBeVisible();
    // Signing in keeps the document first, and returns to it.
    await expect(google).toHaveAttribute('href', /^\/api\/auth\/start\/google\?return=/);
    const href = (await dev.getAttribute('href'))!;
    expect(href).toMatch(/^\/api\/auth\/start\/dev\?return=/);
    const back = decodeURIComponent(new URL(href, 'http://x').searchParams.get('return')!);
    expect(back).toMatch(/^\/\?doc=local:[0-9a-f-]{36}$/);
    await context.close();
  });

  test('"Not now", the close button and Escape all dismiss it', async ({ browser }) => {
    const { context, page, app } = await guest(browser);
    await app.blank();
    const dialog = signInDialog(page);
    for (const dismiss of [
      () => dialog.getByRole('button', { name: 'Not now' }).click(),
      () => dialog.getByRole('button', { name: /close/i }).click(),
      () => page.keyboard.press('Escape'),
    ]) {
      const panel = await openAccountPanel(page);
      await panel.getByRole('button', { name: 'Sign in…' }).click();
      await expect(dialog).toBeVisible();
      await dismiss();
      await expect(dialog).toHaveCount(0);
    }
    // Still a guest, still editing.
    expect(await me(page)).toBeNull();
    await context.close();
  });

  test('a cancelled or failed attempt (?auth_error=) is explained in the dialog and the URL is cleaned', async ({ browser }) => {
    for (const [reason, message] of [
      ['denied', 'Sign-in was cancelled.'],
      ['failed', 'Sign-in failed. Please try again.'],
      ['state', 'Sign-in failed. Please try again.'],
    ] as const) {
      const { context, page, app } = await guest(browser);
      await app.goto(`?doc=welcome&auth_error=${reason}`);
      const panel = await openAccountPanel(page);
      await panel.getByRole('button', { name: 'Sign in…' }).click();
      await expect(signInDialog(page).getByRole('alert')).toHaveText(message);
      expect(new URL(page.url()).searchParams.has('auth_error')).toBe(false);
      await context.close();
    }
  });

  test('choosing a provider signs in and returns to the same document', async ({ browser }) => {
    const { context, page, app } = await guest(browser);
    await app.blank();
    await app.type('my draft');
    const panel = await openAccountPanel(page);
    await panel.getByRole('button', { name: 'Sign in…' }).click();
    await signInDialog(page).getByRole('link', { name: /^Continue with Dev User/ }).click();
    await app.ready();
    await expect(page).toHaveURL(/\?doc=local%3A[0-9a-f-]{36}$/);
    expect((await me(page))?.email).toBe('e2e@example.com');
    // The document came along, and the button now reports saving to the account.
    await expect.poll(() => app.text()).toBe('my draft');
    await expect(page.locator('.wm-account')).toHaveAttribute('data-signed-in', 'true');
    await waitSaved(page);
    await context.close();
  });
});

test.describe('signed in', () => {
  test('the save indicator says saved to the cloud and the account menu names the account', async ({ browser }) => {
    const person = await newPerson(browser, 'acct');
    await person.app.blank();
    await person.app.type('hi');
    await waitSaved(person.page);
    await expect(person.page.locator('.wm-account')).toHaveAttribute('data-signed-in', 'true');
    let panel = await openSyncPanel(person.page);
    await expect(panel).toContainText('Saved to cloud');
    await expect(panel).toContainText('Last saved');
    await person.page.keyboard.press('Escape');
    panel = await openAccountPanel(person.page);
    await expect(panel).toContainText(`Signed in as ${person.email}`);
    await expect(panel.getByRole('button', { name: 'Sign in…' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible();
    expect((await me(person.page))?.email).toBe(person.email);
    await person.context.close();
  });

  test('the dashboard lists the account\'s documents, with no account controls', async ({ browser }) => {
    const person = await newPerson(browser, 'acct');
    await person.app.blank();
    await person.app.type('in the account');
    await waitSaved(person.page);
    await waitForCloudDoc(person.page);
    await person.app.menu('File', 'Open');
    const dashboard = person.page.locator('.wm-dashboard');
    await expect(dashboard).toBeVisible();
    await expect(dashboard.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await expect(dashboard.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
    await expect(dashboard.getByText(/Document1/).first()).toBeVisible();
    await person.context.close();
  });
});

test.describe('signing out', () => {
  test('ends the session, returns to a clean URL and removes the account\'s documents from this browser', async ({ browser }) => {
    const person = await newPerson(browser, 'out');
    await person.app.blank();
    await person.app.type('account doc');
    await waitSaved(person.page);
    await waitForCloudDoc(person.page);
    await expect(person.page).toHaveURL(/\?doc=local%3A/);
    const localUrl = person.page.url();
    const panel = await openAccountPanel(person.page);
    await panel.getByRole('button', { name: 'Sign out' }).click();
    await expect(person.page).not.toHaveURL(/\?doc=/, { timeout: 15_000 });
    await person.app.ready();
    expect(new URL(person.page.url()).search).not.toContain('doc=local');
    expect(await me(person.page)).toBeNull();
    await expect(person.page.locator('.wm-sync')).toHaveAttribute('data-state', 'guest');
    await expect(person.page.locator('.wm-account')).toHaveAttribute('data-signed-in', 'false');
    // The session is really gone: the API refuses, and the cookie no longer works.
    expect((await person.page.request.get('/api/documents')).status()).toBe(401);
    // The copy kept in this browser went with it.
    await person.page.goto(localUrl);
    await person.app.ready();
    await expect.poll(() => statusLine(person.page)).toContain('no longer saved in this browser');
    await person.context.close();
  });

  test('the documents stay in the account: signing back in finds them', async ({ browser }) => {
    const person = await newPerson(browser, 'back');
    await person.app.blank();
    await person.app.type('come back to me');
    await waitSaved(person.page);
    const doc = await waitForCloudDoc(person.page);
    const panel = await openAccountPanel(person.page);
    await panel.getByRole('button', { name: 'Sign out' }).click();
    await expect(person.page).not.toHaveURL(/\?doc=/, { timeout: 15_000 });
    await person.app.ready();
    // Sign back in as the same account.
    const { signInAs } = await import('./helpers');
    await signInAs(person.context, person.email);
    await person.page.goto(`/?doc=cloud:${doc.id}`);
    await person.app.ready();
    await expect.poll(() => person.app.text()).toBe('come back to me');
    await person.context.close();
  });

  test('offline with unsent changes it asks first; Cancel keeps you signed in', async ({ browser }) => {
    const person = await newPerson(browser, 'unsent');
    await person.app.blank();
    await person.app.type('saved part');
    await waitSaved(person.page);
    await person.context.setOffline(true);
    await person.app.type(' unsent part');
    const panel = await openAccountPanel(person.page);
    await panel.getByRole('button', { name: 'Sign out' }).click();
    const confirm = person.page.locator('dialog[open]').filter({ hasText: 'Sign Out Anyway' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('you’re offline');
    await expect(confirm).toContainText('would be lost');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await person.context.setOffline(false);
    expect((await me(person.page))?.email).toBe(person.email);
    await expect.poll(() => person.app.text()).toBe('saved part unsent part');
    await person.context.close();
  });
});

test.describe('Clear Local Data', () => {
  async function confirmDialog(page: Page, confirmLabel: string) {
    return page.locator('dialog[open]').filter({ hasText: confirmLabel });
  }

  test('Cancel changes nothing', async ({ browser }) => {
    const { context, page, app } = await guest(browser);
    await app.blank();
    await app.type('keep me');
    await expect(page).toHaveURL(/\?doc=local%3A/, { timeout: 15_000 });
    const url = page.url();
    await app.menu('File', 'Clear Local Data');
    const dialog = await confirmDialog(page, 'Delete Everything');
    await expect(dialog).toContainText('This deletes');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(page.url()).toBe(url);
    await context.close();
  });

  test('deletes the documents kept in the browser and starts afresh with the welcome document', async ({ browser }) => {
    const { context, page, app } = await guest(browser);
    await app.blank();
    await app.type('delete me');
    await expect(page).toHaveURL(/\?doc=local%3A/, { timeout: 15_000 });
    const url = page.url();
    await app.menu('File', 'Clear Local Data');
    const dialog = await confirmDialog(page, 'Delete Everything');
    await expect(dialog).toContainText('deletes the one document saved in this browser');
    await dialog.getByRole('button', { name: 'Delete Everything' }).click();
    await page.waitForURL((u) => u.search === '');
    await app.ready();
    await expect.poll(() => app.text()).toContain('Welcome to Golem Docs');
    expect(new URL(page.url()).search).toBe('');
    await page.goto(url);
    await app.ready();
    await expect.poll(() => statusLine(page)).toContain('no longer saved in this browser');
    await context.close();
  });

  test('signed in, the account\'s documents are kept and you stay signed in', async ({ browser }) => {
    const person = await newPerson(browser, 'clear');
    await person.app.blank();
    await person.app.type('in the account');
    await waitSaved(person.page);
    const doc = await waitForCloudDoc(person.page);
    await person.app.menu('File', 'Clear Local Data');
    const dialog = await confirmDialog(person.page, 'Delete Everything');
    await expect(dialog).toContainText('Documents saved to your account are kept.');
    await dialog.getByRole('button', { name: 'Delete Everything' }).click();
    await person.page.waitForURL((u) => u.search === '');
    await person.app.ready();
    await expect.poll(() => person.app.text()).toContain('Welcome to Golem Docs');
    expect((await me(person.page))?.email).toBe(person.email);
    const listed = (await (await person.page.request.get('/api/documents')).json()) as { id: string }[];
    expect(listed.map((d) => d.id)).toContain(doc.id);
    // And the account's copy opens again.
    await person.page.goto(`/?doc=cloud:${doc.id}`);
    await person.app.ready();
    await expect.poll(() => person.app.text()).toBe('in the account');
    await person.context.close();
  });
});
