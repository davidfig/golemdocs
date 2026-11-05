// A document's public link (File › Share, "Public link"): anyone with it, signed in or not, opens the document in the read-only viewer
// at /view?p=<token> and can download it; Copy Embed Code puts the same viewer in another site's page; turning the link off or
// resetting it makes the old address stop working (src/viewer/share.ts, docs/architecture/viewer.md#public-links-and-embedding).

import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { test, expect } from '../fixtures';
import { makePdf, openPdf } from '../pdf/helpers';
import { IPHONE, drawerItem, sharedFiles, stubShareSheet } from '../files/helpers';
import { makeDocx, newPerson, openCloud, signInAs, signedOutContext, signOutContext, uniqueEmail, uploadDoc } from './helpers';

/** The viewer page's selected text, by select-all and copy. */
async function viewerText(page: Page): Promise<string> {
  await page.locator('.wm-viewer canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+a');
  await page.waitForTimeout(300);
  await page.keyboard.press('ControlOrMeta+c');
  return page.evaluate(() => navigator.clipboard.readText());
}

test('the owner turns on a public link, and someone signed out reads, downloads and embeds the document', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  const docx = await makeDocx(browser, ['the plan']);
  const doc = await uploadDoc(owner.page, 'Plan.docx', docx);
  await openCloud(owner.page, doc.id);

  await owner.app.menu('File', 'Share');
  const dialog = owner.page.locator('dialog.wm-share');
  const toggle = dialog.getByLabel('Anyone with the link can view');
  await expect(toggle).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Copy Link' })).toBeHidden();
  await toggle.check();
  const address = dialog.getByRole('textbox', { name: 'Public link' });
  await expect(address).toHaveValue(/\/view\?p=[\w-]{32}$/);
  const url = await address.inputValue();
  expect(url).not.toContain(doc.id);
  await dialog.getByRole('button', { name: 'Copy Link' }).click();
  await expect(dialog.getByText('Copied.')).toBeVisible();
  expect(await owner.page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await dialog.getByRole('button', { name: 'Copy Embed Code' }).click();
  const embed = await owner.page.evaluate(() => navigator.clipboard.readText());
  expect(embed).toContain(`src="${url}&amp;embed"`);

  // Signed out: the document, read-only, with a Download button that saves it under its name.
  const stranger = await signedOutContext(browser);
  const page = await stranger.newPage();
  await page.goto(url);
  await expect(page).toHaveTitle('Plan.docx (view only)');
  await expect.poll(() => viewerText(page)).toBe('the plan');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
  expect(download.suggestedFilename()).toBe('Plan.docx');
  expect(readFileSync((await download.path())!)).toEqual(Buffer.from(docx));

  // Embedded in another site's page: the viewer in a frame, with the document's name alone in its bar.
  const host = await stranger.newPage();
  await host.setContent(`<!doctype html><body>${embed}</body>`);
  const frame = host.frameLocator('iframe');
  await expect(frame.locator('.wm-viewer-title')).toHaveText('Plan.docx');
  await expect(frame.getByRole('button', { name: 'Download' })).toBeVisible();

  // Reopened, the dialog shows the link that is on.
  await dialog.getByRole('button', { name: 'Done' }).click();
  await owner.app.menu('File', 'Share');
  await expect(dialog.getByLabel('Anyone with the link can view')).toBeChecked();
  await expect(dialog.getByRole('textbox', { name: 'Public link' })).toHaveValue(url);
  await owner.context.close();
  await stranger.close();
});

test('resetting the link kills the old address, and turning it off kills the link', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  const doc = await uploadDoc(owner.page, 'Plan.docx', await makeDocx(browser, ['the plan']));
  await openCloud(owner.page, doc.id);
  await owner.app.menu('File', 'Share');
  const dialog = owner.page.locator('dialog.wm-share');
  await dialog.getByLabel('Anyone with the link can view').check();
  const address = dialog.getByRole('textbox', { name: 'Public link' });
  await expect(address).toHaveValue(/\/view\?p=/);
  const first = await address.inputValue();

  await dialog.getByRole('button', { name: 'Reset Link' }).click();
  await expect(address).not.toHaveValue(first);
  const second = await address.inputValue();
  const stranger = await signedOutContext(browser);
  const page = await stranger.newPage();
  await page.goto(first);
  await expect(page.getByText('This link no longer works')).toBeVisible();
  await page.goto(second);
  await expect.poll(() => viewerText(page)).toBe('the plan');

  await dialog.getByLabel('Anyone with the link can view').uncheck();
  await expect(address).toBeHidden();
  expect((await (await owner.page.request.get(`/api/documents/${doc.id}/link`)).json()).token).toBeNull();
  // A tab already open clears the next time it checks (when it is looked at again).
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('This link no longer works')).toBeVisible({ timeout: 15_000 });
  await owner.context.close();
  await stranger.close();
});

test('a document just imported can be shared at once: it uploads first, rather than asking to try again', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  await owner.page.goto('/?doc=welcome');
  await owner.app.ready();
  await openPdf(owner.app, makePdf({ pages: [[{ text: 'Hello PDF world', x: 40, y: 240, size: 18 }]] }), 'Fresh.pdf');
  await owner.app.menu('File', 'Share');
  const dialog = owner.page.locator('dialog.wm-share');
  await dialog.getByLabel('Anyone with the link can view').check();
  await expect(dialog.getByRole('textbox', { name: 'Public link' })).toHaveValue(/\/view\?p=/);
  // It is the document in the account now, so someone signed out can read it.
  const stranger = await signedOutContext(browser);
  const page = await stranger.newPage();
  await page.goto(await dialog.getByRole('textbox', { name: 'Public link' }).inputValue());
  await expect(page).toHaveTitle('Fresh.pdf (view only)');
  await stranger.close();
  await owner.context.close();
});

test('on a phone: the owner turns the link on from the menu, and someone signed out downloads through the share sheet', async ({ browser }) => {
  const phone = await browser.newContext({ ...IPHONE, permissions: ['clipboard-read', 'clipboard-write'] });
  await signInAs(phone, uniqueEmail('owner'));
  const page = await phone.newPage();
  await page.goto('/?doc=welcome');
  const docx = await makeDocx(browser, ['the plan']);
  const doc = await uploadDoc(page, 'Plan.docx', docx);
  await openCloud(page, doc.id);
  await drawerItem(page, /^Share/);
  const dialog = page.locator('dialog.wm-share');
  await dialog.getByLabel('Anyone with the link can view').check();
  const address = dialog.getByRole('textbox', { name: 'Public link' });
  await expect(address).toHaveValue(/\/view\?p=/);
  await dialog.getByRole('button', { name: 'Copy Link' }).click();
  await expect(dialog.getByText('Copied.')).toBeVisible();
  const url = await address.inputValue();

  const stranger = await browser.newContext(IPHONE);
  await signOutContext(stranger);
  const reader = await stranger.newPage();
  await stubShareSheet(reader);
  await reader.goto(url);
  await expect(reader).toHaveTitle('Plan.docx (view only)');
  await reader.getByRole('button', { name: 'Download' }).click();
  await expect.poll(() => sharedFiles(reader)).toEqual([{ name: 'Plan.docx', type: expect.stringContaining('wordprocessingml'), head: expect.stringMatching(/^PK/), refused: false }]);
  await phone.close();
  await stranger.close();
});
