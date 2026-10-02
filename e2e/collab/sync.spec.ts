// The save indicator at the top right: saving, saved, offline, failed and "signed out" states, and
// the panel's Try again. (The subscription states belong to billing and aren't covered.)

import { test, expect } from '../fixtures';
import { CLIENT_ORIGIN } from '../ports.ts';
import { newPerson, waitForCloudDoc } from './helpers';

const state = (page: import('@playwright/test').Page, expected: string | RegExp) => expect(page.locator('.wm-sync')).toHaveAttribute('data-state', expected, { timeout: 30_000 });

test.describe('the save indicator when signed in', () => {
  test('goes from saving to saved, and the panel says when', async ({ browser }) => {
    const person = await newPerson(browser, 'sync');
    await person.app.blank();
    await person.app.type('first words');
    await state(person.page, 'saved');
    await expect(person.page.locator('.wm-sync')).toHaveText('Saved');
    await person.page.locator('.wm-sync').click();
    const panel = person.page.locator('.wm-sync-panel');
    await expect(panel).toContainText('Saved to cloud');
    await expect(panel).toContainText(/Last saved /);
    expect((await waitForCloudDoc(person.page)).name).toBe('Document1.docx');
    await person.page.keyboard.press('Escape');
    // Another edit starts another save.
    await person.app.type(' and more');
    await state(person.page, 'saved');
    await expect.poll(async () => (await waitForCloudDoc(person.page)).size).toBeGreaterThan(0);
    await person.context.close();
  });

  test('the account holds what was typed', async ({ browser }) => {
    const person = await newPerson(browser, 'sync');
    await person.app.blank();
    await person.app.type('kept in the cloud');
    await state(person.page, 'saved');
    const doc = await waitForCloudDoc(person.page);
    await person.page.goto(`/?doc=cloud:${doc.id}`);
    await person.app.ready();
    await expect.poll(() => person.app.text()).toBe('kept in the cloud');
    await person.context.close();
  });

  test('offline it says so, keeps the edits, and saves when the connection is back', async ({ browser }) => {
    const person = await newPerson(browser, 'sync');
    await person.app.blank();
    await person.app.type('before');
    await state(person.page, 'saved');
    const { size } = await waitForCloudDoc(person.page);
    await person.context.setOffline(true);
    await person.app.type(' while offline');
    await state(person.page, 'offline');
    await expect(person.page.locator('.wm-sync')).toHaveText('Offline');
    await person.page.locator('.wm-sync').click();
    await expect(person.page.locator('.wm-sync-panel')).toContainText('Keep working');
    await person.page.keyboard.press('Escape');
    await person.context.setOffline(false);
    await state(person.page, 'saved');
    await expect.poll(async () => (await waitForCloudDoc(person.page)).size).not.toBe(size);
    await person.context.close();
  });

  test('a rejected upload shows "Not saved" with the reason; Try again uploads once the server is fine', async ({ browser }) => {
    const person = await newPerson(browser, 'sync');
    let failing = true;
    await person.page.route('**/api/documents**', (route) => {
      const method = route.request().method();
      if (failing && (method === 'POST' || method === 'PUT')) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal error' }) });
      return route.continue();
    });
    await person.app.blank();
    await person.app.type('will not upload yet');
    await state(person.page, 'failed');
    await expect(person.page.locator('.wm-sync')).toHaveText('Not saved');
    await person.page.locator('.wm-sync').click();
    const panel = person.page.locator('.wm-sync-panel');
    await expect(panel).toContainText('couldn’t be saved to your account');
    // The text is still in the document (and in this browser).
    expect(await person.app.text()).toBe('will not upload yet');
    failing = false;
    await panel.getByRole('button', { name: 'Try again' }).click();
    await state(person.page, 'saved');
    expect((await waitForCloudDoc(person.page)).name).toBe('Document1.docx');
    await person.context.close();
  });

  test('when the session ends the indicator asks to sign in again, and the edits stay in the document', async ({ browser }) => {
    const person = await newPerson(browser, 'sync');
    await person.app.blank();
    await person.app.type('saved while signed in');
    await state(person.page, 'saved');
    // The session ends (as if it expired or was revoked).
    await person.context.clearCookies();
    await person.context.addCookies([{ name: 'dev_signed_out', value: '1', url: CLIENT_ORIGIN }]);
    await person.app.type(' and then more');
    await state(person.page, 'signedOut');
    await expect(person.page.locator('.wm-sync')).toHaveText('Sign in to save');
    await person.page.locator('.wm-sync').click();
    const panel = person.page.locator('.wm-sync-panel');
    await expect(panel).toContainText('Signed out');
    await panel.getByRole('button', { name: 'Sign in…' }).click();
    await expect(person.page.locator('dialog[open]').filter({ hasText: 'Not now' })).toBeVisible();
    await person.page.keyboard.press('Escape');
    expect(await person.app.text()).toBe('saved while signed in and then more');
    await person.context.close();
  });

  test('the account menu is told the same: no longer signed in', async ({ browser }) => {
    const person = await newPerson(browser, 'sync');
    await person.app.blank();
    await person.app.type('x');
    await state(person.page, 'saved');
    await expect(person.page.locator('.wm-account')).toHaveAttribute('data-signed-in', 'true');
    await person.context.clearCookies();
    await person.context.addCookies([{ name: 'dev_signed_out', value: '1', url: CLIENT_ORIGIN }]);
    await person.app.type('y');
    await state(person.page, 'signedOut');
    await expect(person.page.locator('.wm-account')).toHaveAttribute('data-signed-in', 'false');
    await person.context.close();
  });
});
