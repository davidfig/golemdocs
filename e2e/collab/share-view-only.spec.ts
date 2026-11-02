// Sharing a document view-only (File ▸ Share, "Can view") and opening it: the other person gets the read-only viewer at
// /view/?s=<token> (src/viewer/share.ts, docs/architecture/viewer.md), not the editor, under the share's own address that never names
// the document; it catches up with each save; and the server refuses them any change whatever the page does.

import type { Page, Response } from '@playwright/test';
import { test, expect } from '../fixtures';
import { makeDocx, newPerson, openCloud, shareWith, signedOutContext, uploadDoc } from './helpers';
import { CLIENT_ORIGIN } from '../ports.ts';

/** The grantee's viewer address of a shared document, from their "shared with me" list (the app's API). */
async function viewTokenOf(page: Page, id: string): Promise<string> {
  const listed = (await (await page.request.get('/api/shared')).json()) as { id: string; viewToken?: string }[];
  return listed.find((d) => d.id === id)!.viewToken!;
}

/** Every response a page gets from now on, to check that none of them names the document. */
function recordResponses(page: Page): Response[] {
  const seen: Response[] = [];
  page.on('response', (response) => seen.push(response));
  return seen;
}

/** Fails if any response's address, headers or text names `id`. */
async function expectNoId(responses: Response[], id: string): Promise<void> {
  expect(responses.length).toBeGreaterThan(0);
  for (const response of responses) {
    expect(response.url(), 'address').not.toContain(id);
    for (const [name, value] of Object.entries(await response.allHeaders())) expect(value, `${response.url()} ${name}`).not.toContain(id);
    const type = (await response.allHeaders())['content-type'] ?? '';
    if (/json|text|html/.test(type) && response.status() !== 304) expect(await response.text().catch(() => ''), response.url()).not.toContain(id);
  }
}

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

  // Opened the way the app opens a shared document, it lands in the viewer instead of the editor, at an address of its own.
  await guest.page.goto(`/?doc=shared:${doc.id}`);
  await guest.page.waitForURL(/\/view\/\?s=[\w-]{32}$/);
  expect(guest.page.url()).not.toContain(doc.id);
  expect(new URL(guest.page.url()).searchParams.get('s')).toBe(await viewTokenOf(guest.page, doc.id));
  await expect(guest.page).toHaveTitle('Plan.docx (view only)');
  await expect(guest.page.locator('.wm-viewer-title')).toHaveText('Plan.docx (view only)');
  await expect(guest.page.getByRole('textbox', { name: 'Page number' })).toHaveValue('1');
  await expect(guest.page.getByRole('menubar')).toHaveCount(0);
  await expect.poll(() => viewerText(guest.page)).toBe('the plan');
  // Nothing on the page names the document: not the address, the title, the bar, or anything it was sent.
  const viewing = recordResponses(guest.page);
  await guest.page.reload();
  await expect.poll(() => viewerText(guest.page)).toBe('the plan');
  await expectNoId(viewing, doc.id);
  expect(await guest.page.content()).not.toContain(doc.id);
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
  const viewing = recordResponses(guest.page);
  await guest.page.goto(`/view/?s=${await viewTokenOf(guest.page, doc.id)}`);
  await expect.poll(() => viewerText(guest.page)).toBe('first version');

  // Whatever the page does, a viewer can't change the file.
  const put = await guest.page.request.put(`/api/documents/${doc.id}`, { data: await makeDocx(browser, ['hacked']), headers: { origin: CLIENT_ORIGIN } });
  expect(put.status()).toBe(403);

  // The owner saves a new version; the viewer shows it the next time it checks (every half minute, or when the tab is looked at again).
  const saved = await owner.page.request.put(`/api/documents/${doc.id}`, { data: await makeDocx(browser, ['second version']), headers: { origin: CLIENT_ORIGIN } });
  expect(saved.status()).toBe(200);
  await guest.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => viewerText(guest.page), { timeout: 15_000 }).toBe('second version');
  await expectNoId(viewing.filter((r) => new URL(r.url()).pathname.startsWith('/api/view/') || new URL(r.url()).pathname.startsWith('/view/')), doc.id);
  await owner.context.close();
  await guest.context.close();
});

test('the address dies when the share becomes an editor\'s, the document\'s id opens nothing, and someone signed out is asked to sign in', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  const guest = await newPerson(browser, 'guest');
  await guest.page.goto('/?doc=welcome');
  await owner.page.goto('/?doc=welcome');
  const doc = await uploadDoc(owner.page, 'Plan.docx', await makeDocx(browser, ['the plan']));
  await shareWith(owner.page, doc.id, guest.email, 'viewer');
  const token = await viewTokenOf(guest.page, doc.id);

  // Signed out: asked to sign in, coming back to the same address (which still doesn't name the document).
  const stranger = await signedOutContext(browser);
  const page = await stranger.newPage();
  await page.goto(`/view/?s=${token}`);
  await expect(page.getByRole('status')).toContainText('Sign in to see this document.');
  const signIn = page.getByRole('link', { name: /^Continue with/ }).first();
  const href = (await signIn.getAttribute('href'))!;
  expect(new URL(href, CLIENT_ORIGIN).searchParams.get('return')).toBe(`/view/?s=${token}`);
  expect(await page.content()).not.toContain(doc.id);
  await stranger.close();

  // The document's own id is no address.
  await guest.page.goto(`/view/?s=${doc.id}`);
  await expect(guest.page.getByRole('status')).toContainText('no longer shared with you');

  // Made an editor: the viewer address is gone, and the app opens it in the editor.
  await shareWith(owner.page, doc.id, guest.email, 'editor');
  await guest.page.goto(`/view/?s=${token}`);
  await expect(guest.page.getByRole('status')).toContainText('no longer shared with you');
  await guest.page.goto(`/?doc=shared:${doc.id}`);
  await guest.app.ready();
  await expect.poll(() => guest.app.text()).toBe('the plan');
  expect(guest.page.url()).not.toContain('/view/');
  await owner.context.close();
  await guest.context.close();
});

/** Makes the open viewer check for a newer save now (as it does when its tab is looked at again), rather than in half a minute. */
const checkNow = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

/** The open viewer has let the document go: the message instead of its pages, and nothing of it left on the page. */
async function expectGone(page: Page): Promise<void> {
  await expect(page.getByRole('status')).toContainText('no longer shared with you');
  await expect(page.locator('.wm-viewer canvas')).toHaveCount(0);
  await expect(page.locator('.wm-viewer-title')).toHaveCount(0);
  await expect(page).not.toHaveTitle(/Plan\.docx/);
  expect(await page.content()).not.toContain('the plan');
}

test('an open viewer lets the document go once the owner removes the person in the Share dialog, and a reload stays gone', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  const guest = await newPerson(browser, 'guest');
  await guest.page.goto('/?doc=welcome');
  const doc = await uploadDoc(owner.page, 'Plan.docx', await makeDocx(browser, ['the plan']));
  await openCloud(owner.page, doc.id);
  await shareWith(owner.page, doc.id, guest.email, 'viewer');
  const address = `/view/?s=${await viewTokenOf(guest.page, doc.id)}`;
  await guest.page.goto(address);
  await expect.poll(() => viewerText(guest.page)).toBe('the plan');

  await owner.app.menu('File', 'Share');
  const dialog = owner.page.locator('dialog.wm-share');
  await dialog.getByRole('listitem').filter({ hasText: guest.email }).getByRole('button', { name: 'Remove' }).click();
  await expect(dialog.getByText('Not shared with anyone yet.')).toBeVisible();

  await checkNow(guest.page);
  await expectGone(guest.page);
  await guest.page.goto(address);
  await expectGone(guest.page);
  await owner.context.close();
  await guest.context.close();
});

test('an open viewer lets the document go once the person leaves it from their dashboard', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  const guest = await newPerson(browser, 'guest');
  await guest.page.goto('/?doc=welcome');
  await owner.page.goto('/?doc=welcome');
  const doc = await uploadDoc(owner.page, 'Plan.docx', await makeDocx(browser, ['the plan']));
  await shareWith(owner.page, doc.id, guest.email, 'viewer');
  const address = `/view/?s=${await viewTokenOf(guest.page, doc.id)}`;
  const viewer = await guest.context.newPage();
  await viewer.goto(address);
  await expect.poll(() => viewerText(viewer)).toBe('the plan');

  // In another tab of theirs: File › Open, the card under "Shared with me", Leave (asked twice, like every such button).
  await guest.page.goto('/?doc=welcome');
  await guest.app.ready();
  await guest.app.menu('File', 'Open');
  const card = guest.page.locator('.wm-dashboard article.wm-card').filter({ hasText: 'Plan.docx' });
  await expect(card).toBeVisible();
  // A card's buttons show when it is pointed at.
  await card.hover();
  const leave = card.locator('button.wm-danger');
  await leave.click();
  await leave.click();
  await expect(card).toHaveCount(0);

  await viewer.bringToFront();
  await checkNow(viewer);
  await expectGone(viewer);
  await viewer.reload();
  await expectGone(viewer);
  await owner.context.close();
  await guest.context.close();
});
