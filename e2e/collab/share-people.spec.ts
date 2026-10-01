// File ▸ Share ▸ People: sharing a cloud document with other accounts by email, with an editor or
// viewer role, and what those accounts then see. Accounts are dev-provider sessions (helpers.ts);
// the people being shared with must have signed in once, which `newPerson` does.

import { test, expect, App } from '../fixtures';
import { cloudPair, makeDocx, newPerson, openCloud, shareWith, uploadDoc, waitSaved } from './helpers';
import type { Browser, Page } from '@playwright/test';

interface Share {
  userId: string;
  name: string | null;
  email: string | null;
  role: 'editor' | 'viewer';
}

const sharesOf = async (page: Page, id: string): Promise<Share[]> => (await (await page.request.get(`/api/documents/${id}/shares`)).json()) as Share[];

/** An owner with a cloud document open, and somebody else who has signed in once. */
async function ownerAndGuest(browser: Browser) {
  const owner = await newPerson(browser, 'owner');
  const guest = await newPerson(browser, 'guest');
  await guest.page.goto('/?doc=welcome'); // signs them in to the app (their identity is known to the server from the session start)
  const doc = await uploadDoc(owner.page, 'Plan.docx', await makeDocx(browser, ['the plan']));
  await openCloud(owner.page, doc.id);
  return { owner, guest, doc };
}

async function openShareDialog(app: App) {
  await app.menu('File', 'Share');
  const dialog = app.page.locator('dialog.wm-share');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('the People section of the Share dialog', () => {
  test('an account document shows the people form, empty at first', async ({ browser }) => {
    const { owner } = await ownerAndGuest(browser);
    const dialog = await openShareDialog(owner.app);
    await expect(dialog.getByRole('heading', { name: 'People' })).toBeVisible();
    await expect(dialog.getByText('People need to have signed in to Golem Docs once.')).toBeVisible();
    await expect(dialog.getByText('Not shared with anyone yet.')).toBeVisible();
    await expect(dialog.getByLabel('Email address')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
    await owner.context.close();
  });

  test('sharing with an email that never signed in says so', async ({ browser }) => {
    const { owner, doc } = await ownerAndGuest(browser);
    const dialog = await openShareDialog(owner.app);
    await dialog.getByLabel('Email address').fill('nobody-here@example.com');
    await dialog.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(dialog.getByRole('status').last()).toHaveText('nobody with that email has signed in to Golem Docs yet');
    expect(await sharesOf(owner.page, doc.id)).toEqual([]);
    await owner.context.close();
  });

  test('you cannot share with yourself', async ({ browser }) => {
    const { owner, doc } = await ownerAndGuest(browser);
    const dialog = await openShareDialog(owner.app);
    await dialog.getByLabel('Email address').fill(owner.email);
    await dialog.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(dialog.getByRole('status').last()).toHaveText('you already own this document');
    expect(await sharesOf(owner.page, doc.id)).toEqual([]);
    await owner.context.close();
  });

  test('an empty address does nothing', async ({ browser }) => {
    const { owner, doc } = await ownerAndGuest(browser);
    const dialog = await openShareDialog(owner.app);
    await dialog.getByLabel('Email address').fill('   ');
    await dialog.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(dialog.getByRole('status').last()).toHaveText('');
    expect(await sharesOf(owner.page, doc.id)).toEqual([]);
    await owner.context.close();
  });

  test('share by email as an editor, change to a viewer, then remove', async ({ browser }) => {
    const { owner, guest, doc } = await ownerAndGuest(browser);
    const dialog = await openShareDialog(owner.app);
    await dialog.getByLabel('Email address').fill(guest.email.toUpperCase()); // addresses are matched case-insensitively
    await dialog.getByRole('button', { name: 'Share', exact: true }).click();
    const row = dialog.getByRole('listitem').filter({ hasText: guest.email });
    await expect(row).toBeVisible();
    await expect(row).toContainText(`${guest.name} (${guest.email})`);
    const access = row.getByLabel('Access');
    await expect(access).toHaveValue('editor');
    await expect(dialog.getByLabel('Email address')).toHaveValue('');
    expect((await sharesOf(owner.page, doc.id)).map((s) => [s.email, s.role])).toEqual([[guest.email, 'editor']]);

    await access.selectOption('viewer');
    await expect.poll(async () => (await sharesOf(owner.page, doc.id))[0]?.role).toBe('viewer');

    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(dialog.getByText('Not shared with anyone yet.')).toBeVisible();
    expect(await sharesOf(owner.page, doc.id)).toEqual([]);
    await owner.context.close();
    await guest.context.close();
  });

  test('the list is there again when the dialog is reopened', async ({ browser }) => {
    const { owner, guest, doc } = await ownerAndGuest(browser);
    await shareWith(owner.page, doc.id, guest.email, 'viewer');
    const dialog = await openShareDialog(owner.app);
    const row = dialog.getByRole('listitem').filter({ hasText: guest.email });
    await expect(row.getByLabel('Access')).toHaveValue('viewer');
    await owner.context.close();
    await guest.context.close();
  });
});

test.describe('what the other person sees', () => {
  test('the document appears in their "shared with me" list with its role and owner', async ({ browser }) => {
    const { owner, guest, doc } = await ownerAndGuest(browser);
    expect(await (await guest.page.request.get('/api/shared')).json()).toEqual([]);
    await shareWith(owner.page, doc.id, guest.email, 'viewer');
    const shared = (await (await guest.page.request.get('/api/shared')).json()) as { id: string; name: string; role: string; owner: { email: string } }[];
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ id: doc.id, name: 'Plan.docx', role: 'viewer', owner: { email: owner.email } });
    await owner.context.close();
    await guest.context.close();
  });

  test('the dashboard lists it under "Shared with me"', async ({ browser }) => {
    const { owner, guest, doc } = await ownerAndGuest(browser);
    await shareWith(owner.page, doc.id, guest.email, 'editor');
    await guest.page.goto('/?doc=welcome');
    await guest.app.ready();
    await guest.app.menu('File', 'Open');
    const dashboard = guest.page.locator('.wm-dashboard');
    await expect(dashboard.getByText('Shared with me')).toBeVisible();
    await expect(dashboard.getByText('Plan.docx')).toBeVisible();
    await expect(dashboard.getByText(`From ${owner.name}`).first()).toBeVisible();
    await owner.context.close();
    await guest.context.close();
  });

  test('a document that is no longer shared (or never was) says so when opened', async ({ browser }) => {
    const { owner, guest, doc } = await ownerAndGuest(browser);
    await guest.page.goto(`/?doc=shared:${doc.id}`);
    await guest.app.ready();
    await expect.poll(() => guest.page.evaluate(() => (window as unknown as { status: string }).status)).toContain('no longer shared with you');
    await owner.context.close();
    await guest.context.close();
  });

  test('a shared document opens for the other person with its text', async ({ browser }) => {
    test.fixme(true, 'Suspected app bug: ?doc=shared:<id> opens the cloud file as a plain .docx (docx-url), but the app stores documents in its own wrapper format, so it fails with "not an Office document: [Content_Types].xml is missing"');
    const { owner, guest, doc } = await ownerAndGuest(browser);
    await shareWith(owner.page, doc.id, guest.email, 'editor');
    await guest.page.goto(`/?doc=shared:${doc.id}`);
    await guest.app.ready();
    await expect.poll(() => guest.app.text()).toBe('the plan');
    await owner.context.close();
    await guest.context.close();
  });
});

test.describe('live editing between two accounts', () => {
  test('an editor and the owner edit the same shared document together', async ({ browser }) => {
    test.fixme(true, 'Blocked by the shared-document open bug above (?doc=shared:<id> fails to load)');
    const { owner, guest, doc } = await ownerAndGuest(browser);
    await shareWith(owner.page, doc.id, guest.email, 'editor');
    await owner.app.focus();
    await guest.page.goto(`/?doc=shared:${doc.id}`);
    await guest.app.ready();
    await guest.app.type(' + guest');
    await expect.poll(() => owner.app.text()).toContain('+ guest');
    await owner.context.close();
    await guest.context.close();
  });

  test('a viewer sees the document read-only, and the status line says so', async ({ browser }) => {
    test.fixme(true, 'Blocked by the shared-document open bug above (?doc=shared:<id> fails to load)');
    const { owner, guest, doc } = await ownerAndGuest(browser);
    await shareWith(owner.page, doc.id, guest.email, 'viewer');
    await guest.page.goto(`/?doc=shared:${doc.id}`);
    await guest.app.ready();
    await expect.poll(() => guest.page.evaluate(() => (window as unknown as { status: string }).status)).toContain('view only');
    await owner.context.close();
    await guest.context.close();
  });

  test('removing someone from the share ends their access', async ({ browser }) => {
    const { owner, guest, doc } = await ownerAndGuest(browser);
    await shareWith(owner.page, doc.id, guest.email, 'editor');
    expect((await guest.page.request.get(`/api/documents/${doc.id}`)).status()).toBe(200);
    const [{ userId }] = await sharesOf(owner.page, doc.id);
    const response = await owner.page.request.delete(`/api/documents/${doc.id}/shares/${userId}`, { headers: { origin: 'http://localhost:5273' } });
    expect(response.status()).toBe(204);
    expect((await guest.page.request.get(`/api/documents/${doc.id}`)).status()).toBe(404);
    await owner.context.close();
    await guest.context.close();
  });
});

test('Share on a document that has not reached the account yet explains why', async ({ browser }) => {
  const owner = await newPerson(browser, 'fresh');
  await owner.app.blank();
  // Nothing typed yet: a blank new document isn't saved, let alone uploaded.
  await owner.app.menu('File', 'Share');
  const dialog = owner.page.locator('dialog.wm-share');
  await expect(dialog.getByText(/Make a change first|give it a moment to upload/)).toBeVisible();
  await expect(dialog.getByLabel('Email address')).toHaveCount(0);
  await owner.context.close();
});

test('the account document is also the room: sharing works while a second device is in it', async ({ browser }) => {
  const { a, b, doc } = await cloudPair(browser, ['both here']);
  const guest = await newPerson(browser, 'late');
  await guest.page.goto('/?doc=welcome');
  await a.app.menu('File', 'Share');
  const dialog = a.page.locator('dialog.wm-share');
  await dialog.getByLabel('Email address').fill(guest.email);
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.getByRole('listitem').filter({ hasText: guest.email })).toBeVisible();
  expect(await sharesOf(a.page, doc.id)).toHaveLength(1);
  await waitSaved(a.page);
  await b.context.close();
  await guest.context.close();
  await a.context.close();
});
