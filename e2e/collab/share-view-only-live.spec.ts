// A view-only page follows the edits: the document's room tells it of each save over its live line (src/viewer/live.ts, the
// server's room.ts listeners), and it shows the newer file within a moment, not at its next check (every half minute, or two
// minutes for a public link). Nothing here nudges the page to check.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { folderProject, makeDocx, newPerson, openCloud, shareWith, signedOutContext, uploadDoc } from './helpers';
import { CLIENT_ORIGIN } from '../ports.ts';

/** Well inside the page's own checks, so only the live line can explain catching up. */
const LIVE_MS = 10_000;

/** A 200 × 120 PNG, red on the left half and white on the right. */
async function makePng(page: Page): Promise<Buffer> {
  const data = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 120;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 200, 120);
    ctx.fillStyle = '#d02020';
    ctx.fillRect(0, 0, 100, 120);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  return Buffer.from(data);
}

/** The viewer page's selected text, by select-all and copy. */
async function viewerText(page: Page): Promise<string> {
  await page.locator('.wm-viewer canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+a');
  await page.waitForTimeout(300);
  await page.keyboard.press('ControlOrMeta+c');
  return page.evaluate(() => navigator.clipboard.readText());
}

test('a picture shared "Can view" shows the owner\'s edits as they are saved', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  const guest = await newPerson(browser, 'guest');
  await guest.page.goto('/?doc=welcome');
  await owner.page.goto('/?doc=welcome');
  const doc = await uploadDoc(owner.page, 'Red.png', await makePng(owner.page));
  await shareWith(owner.page, doc.id, guest.email, 'viewer');
  const listed = (await (await guest.page.request.get('/api/shared')).json()) as { id: string; viewToken?: string }[];
  const opened = guest.page.waitForEvent('websocket', (ws) => ws.url().endsWith('/live'));
  await guest.page.goto(`/view?s=${listed.find((d) => d.id === doc.id)!.viewToken!}`);
  await opened;
  const canvas = guest.page.locator('.wm-viewer canvas');
  await expect(canvas).toBeVisible();
  await guest.page.waitForTimeout(1500);
  const before = await canvas.screenshot();

  const app = await openCloud(owner.page, doc.id);
  const updated = async () => ((await (await owner.page.request.get('/api/documents')).json()) as { id: string; updatedAt: number }[]).find((d) => d.id === doc.id)!.updatedAt;
  const updatedBefore = await updated();
  await app.run('image.invert');
  await app.idle();
  await expect.poll(updated, { timeout: 20_000 }).toBeGreaterThan(updatedBefore);

  // The picture is drawn again from the newer file (not from the old one's texture, which has the same name).
  await expect.poll(async () => (await canvas.screenshot()).equals(before), { timeout: LIVE_MS }).toBe(false);
  await owner.context.close();
  await guest.context.close();
});

test('a public link, open signed out, follows each save; resetting the link ends it', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  await owner.page.goto('/?doc=welcome');
  const doc = await uploadDoc(owner.page, 'Plan.docx', await makeDocx(browser, ['first version']));
  const link = (await (await owner.page.request.put(`/api/documents/${doc.id}/link`, { headers: { origin: CLIENT_ORIGIN } })).json()) as { token: string };
  const visitor = await (await signedOutContext(browser)).newPage();
  const opened = visitor.waitForEvent('websocket', (ws) => ws.url().endsWith('/live'));
  await visitor.goto(`/view?p=${link.token}`);
  await opened;
  await expect.poll(() => viewerText(visitor)).toBe('first version');

  for (const text of ['second version', 'third version']) {
    const saved = await owner.page.request.put(`/api/documents/${doc.id}`, { data: await makeDocx(browser, [text]), headers: { origin: CLIENT_ORIGIN } });
    expect(saved.status()).toBe(200);
    await expect.poll(() => viewerText(visitor), { timeout: LIVE_MS }).toBe(text);
  }

  // A new link in place of the old: the room lets the page go, and the page finds the old link dead.
  expect((await owner.page.request.post(`/api/documents/${doc.id}/link`, { headers: { origin: CLIENT_ORIGIN } })).ok()).toBe(true);
  await expect(visitor.getByRole('status')).toContainText(/no longer/i, { timeout: LIVE_MS });
  await expect(visitor.locator('.wm-viewer canvas')).toHaveCount(0);
  await owner.context.close();
  await visitor.context().close();
});

test('a shared folder\'s page follows saves of the file it shows', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  await owner.page.goto('/?doc=welcome');
  const folderId = await folderProject(owner.page);
  const { token } = (await (await owner.page.request.put(`/api/folders/${folderId}/link`, { headers: { origin: CLIENT_ORIGIN } })).json()) as { token: string };
  const readme = ((await (await owner.page.request.get('/api/documents')).json()) as { id: string; name: string }[]).find((d) => d.name === 'README.md')!;
  const visitor = await (await signedOutContext(browser)).newPage();
  const opened = visitor.waitForEvent('websocket', (ws) => /\/live\?path=README\.md$/.test(ws.url()));
  await visitor.goto(`/view?pf=${token}`);
  await opened;
  await expect(visitor).toHaveTitle('README.md (view only) · Project');

  const saved = await owner.page.request.put(`/api/documents/${readme.id}`, { data: Buffer.from('Rewritten while you watch\n', 'utf8'), headers: { origin: CLIENT_ORIGIN } });
  expect(saved.status(), await saved.text()).toBe(200);
  await expect.poll(() => viewerText(visitor), { timeout: LIVE_MS }).toBe('Rewritten while you watch');
  await owner.context.close();
  await visitor.context().close();
});
