// Live blocks in a document edited together (docs/live-blocks.md §6): only the owner has what its blocks read, so of the
// owner's sessions in the room, the one there longest updates them, as an edit through the room that everyone sees. A
// person it is shared with is told the owner keeps the block up to date, and has no Update Now.

import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { cloudDocs, newPerson, roomOf, shareWith, uploadDoc } from '../collab/helpers';
import { CLIENT_ORIGIN } from '../ports.ts';

const liveUpdater = (page: Page) => page.evaluate(() => (window as unknown as { room: { mode: string; liveUpdater: boolean } | null }).room);

test('the owner updates a block of a document edited together, and the person it is shared with sees it', async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await newPerson(browser, 'live-room-owner');
  const guest = await newPerson(browser, 'live-room-guest');
  await owner.page.goto(CLIENT_ORIGIN);
  const budget = await uploadDoc(owner.page, 'Budget.csv', Buffer.from('Item,Cost\nRent,100\n'));
  const costs = await uploadDoc(owner.page, 'Costs.md', Buffer.from('Costs:\n\n![[Budget.csv]]\n\nEnd.\n'));
  await shareWith(owner.page, costs.id, guest.email, 'editor');

  await owner.page.goto(`/?doc=cloud:${costs.id}`);
  await owner.app.ready();
  await expect.poll(() => owner.app.text(), { timeout: 20_000 }).toContain('100');
  // Opening it put its block in and saved it, as the app keeps a note: in the account before the guest opens it.
  await expect.poll(async () => (await cloudDocs(owner.page)).find((d) => d.id === costs.id)?.updatedAt ?? 0, { timeout: 30_000 }).toBeGreaterThan(costs.updatedAt);
  await guest.page.goto(`/?doc=shared:${costs.id}`);
  await guest.app.ready();
  await expect.poll(async () => (await roomOf(owner.page))?.people.length ?? 0, { timeout: 30_000 }).toBe(2);
  await expect.poll(async () => (await liveUpdater(owner.page))?.liveUpdater, { timeout: 30_000 }).toBe(true);
  expect((await liveUpdater(guest.page))?.liveUpdater).toBe(false);

  // The guest's card: the owner keeps it up to date, and there is no Update Now.
  await guest.app.focus();
  await guest.app.press('ControlOrMeta+Home');
  await guest.app.press('ArrowDown');
  const guestCard = guest.page.getByRole('dialog', { name: 'Live Block' });
  await expect(guestCard.getByText(/Kept up to date by .*’s devices/)).toBeVisible({ timeout: 10_000 });
  await expect(guestCard.getByRole('button', { name: 'Update Now' })).toBeHidden();
  await guestCard.getByRole('button', { name: 'Close' }).click();

  // The budget changes elsewhere; the guest types meanwhile; the owner updates. The guest's edit stays, and both see 250.
  const response = await owner.page.request.put(`/api/documents/${budget.id}?base=${budget.updatedAt}`, { data: Buffer.from('Item,Cost\nRent,250\n'), headers: { origin: CLIENT_ORIGIN } });
  expect(response.status(), await response.text()).toBe(200);
  await guest.app.press('ControlOrMeta+End');
  await guest.app.type(' Signed.');
  await expect.poll(() => owner.app.text(), { timeout: 20_000 }).toContain('Signed.');

  await owner.app.focus();
  await owner.app.press('ControlOrMeta+Home');
  await owner.app.press('ArrowDown');
  const card = owner.page.getByRole('dialog', { name: 'Live Block' });
  await card.getByRole('button', { name: 'Update Now' }).click();
  await expect.poll(() => guest.app.text(), { timeout: 30_000 }).toContain('250');
  expect(await guest.app.text()).toContain('Signed.');
  expect(await owner.app.text()).toContain('250');
  await owner.context.close();
  await guest.context.close();
});
