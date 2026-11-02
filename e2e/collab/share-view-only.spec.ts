// Sharing a document view-only (File ▸ Share, "Can view") and opening it: the other person gets the read-only viewer at
// /view/?doc=<id> (src/viewer/share.ts, docs/architecture/viewer.md), not the editor; it catches up with each save; and the server
// refuses them any change whatever the page does.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { makeDocx, newPerson, openCloud, shareWith, signedOutContext, uploadDoc } from './helpers';
import { CLIENT_ORIGIN } from '../ports.ts';

/** The viewer page's selected text, by select-all and copy. */
async function viewerText(page: Page): Promise<string> {
  await page.locator('.wm-viewer canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+a');
  await page.waitForTimeout(300);
  await page.keyboard.press('ControlOrMeta+c');
  return page.evaluate(() => navigator.clipboard.readText());
}

test('the owner shares a document with "Can view", and the other person opens it in the viewer, read-only', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  const guest = await newPerson(browser, 'guest');
  await guest.page.goto('/?doc=welcome'); // they have signed in once
  const doc = await uploadDoc(owner.page, 'Plan.docx', await makeDocx(browser, ['the plan']));
  await openCloud(owner.page, doc.id);

  await owner.app.menu('File', 'Share');
  const dialog = owner.page.locator('dialog.wm-share');
  await dialog.getByLabel('Email address').fill(guest.email);
  await dialog.locator('form').getByRole('button', { name: 'Can view' }).click();
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  const row = dialog.getByRole('listitem').filter({ hasText: guest.email });
  await expect(row.getByRole('button', { name: 'Can view' })).toHaveAttribute('aria-pressed', 'true');
  const shares = (await (await owner.page.request.get(`/api/documents/${doc.id}/shares`)).json()) as { email: string; role: string }[];
  expect(shares.map((s) => [s.email, s.role])).toEqual([[guest.email, 'viewer']]);

  // Opened the way the app opens a shared document, it lands in the viewer instead of the editor.
  await guest.page.goto(`/?doc=shared:${doc.id}`);
  await guest.page.waitForURL(`**/view/?doc=${doc.id}`);
  await expect(guest.page).toHaveTitle('Plan.docx (view only)');
  await expect(guest.page.locator('.wm-viewer-title')).toHaveText('Plan.docx (view only)');
  await expect(guest.page.getByRole('textbox', { name: 'Page number' })).toHaveValue('1');
  await expect(guest.page.getByRole('menubar')).toHaveCount(0);
  await expect.poll(() => viewerText(guest.page)).toBe('the plan');
  // Typing goes nowhere.
  await guest.page.keyboard.type('changed by the viewer');
  await guest.page.keyboard.press('Enter');
  await expect.poll(() => viewerText(guest.page)).toBe('the plan');
  await owner.context.close();
  await guest.context.close();
});

test('the viewer catches up with a newer save, and the server refuses the viewer\'s own writes', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  const guest = await newPerson(browser, 'guest');
  await guest.page.goto('/?doc=welcome');
  await owner.page.goto('/?doc=welcome');
  const doc = await uploadDoc(owner.page, 'Plan.docx', await makeDocx(browser, ['first version']));
  await shareWith(owner.page, doc.id, guest.email, 'viewer');
  await guest.page.goto(`/view/?doc=${doc.id}`);
  await expect.poll(() => viewerText(guest.page)).toBe('first version');

  // Whatever the page does, a viewer can't change the file.
  const put = await guest.page.request.put(`/api/documents/${doc.id}`, { data: await makeDocx(browser, ['hacked']), headers: { origin: CLIENT_ORIGIN } });
  expect(put.status()).toBe(403);

  // The owner saves a new version; the viewer shows it the next time it checks (every half minute, or when the tab is looked at again).
  const saved = await owner.page.request.put(`/api/documents/${doc.id}`, { data: await makeDocx(browser, ['second version']), headers: { origin: CLIENT_ORIGIN } });
  expect(saved.status()).toBe(200);
  await guest.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => viewerText(guest.page), { timeout: 15_000 }).toBe('second version');
  await owner.context.close();
  await guest.context.close();
});

test('someone who may edit is sent to the editor, and someone signed out is asked to sign in', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  const guest = await newPerson(browser, 'guest');
  await guest.page.goto('/?doc=welcome');
  await owner.page.goto('/?doc=welcome');
  const doc = await uploadDoc(owner.page, 'Plan.docx', await makeDocx(browser, ['the plan']));
  await shareWith(owner.page, doc.id, guest.email, 'editor');
  await guest.page.goto(`/view/?doc=${doc.id}`);
  await guest.page.waitForURL(`**/?doc=shared%3A${doc.id}`);
  await guest.app.ready();
  await expect.poll(() => guest.app.text()).toBe('the plan');

  const stranger = await signedOutContext(browser);
  const page = await stranger.newPage();
  await page.goto(`/view/?doc=${doc.id}`);
  await expect(page.getByRole('status')).toContainText('Sign in to see this document.');
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', `/?doc=shared%3A${doc.id}`);
  await stranger.close();
  await owner.context.close();
  await guest.context.close();
});
