// Live blocks kept up to date in the background (docs/live-blocks.md §6, *Updates in the background*): a source changed where
// none of the owner's devices saw it (another person, an agent, a phone that closed) is in the account, and the owner's next
// session updates what shows it without the note being opened. The other change is played by a save straight to the API.

import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { cloudDocs, newPerson, openCloud, uploadDoc } from '../collab/helpers';
import { CLIENT_ORIGIN } from '../ports.ts';

const marker = async (page: Page) => ((await (await page.request.get('/api/live-marker')).json()) as { workedTo: number | null }).workedTo;
const updatedAt = async (page: Page, name: string) => (await cloudDocs(page)).find((d) => d.name === name)?.updatedAt ?? 0;

test('a source changed in the account updates the notes that show it in the background, unopened', async ({ browser }) => {
  test.setTimeout(150_000);
  const { page, context } = await newPerson(browser, 'live-background');
  // The updates run in the live worker: the page would say so if it had to do them itself.
  const fellBack: string[] = [];
  page.on('console', (message) => message.text().includes('live worker did not work') && fellBack.push(message.text()));
  await page.goto(CLIENT_ORIGIN);
  const budget = await uploadDoc(page, 'Budget.csv', Buffer.from('Item,Cost\nRent,100\n'));
  await uploadDoc(page, 'Costs.md', Buffer.from('Costs:\n\n![[Budget.csv]]\n'));

  // The first session sets the account's marker.
  await page.goto('/?doc=welcome');
  await expect.poll(() => marker(page), { timeout: 60_000 }).not.toBeNull();
  const before = await updatedAt(page, 'Costs.md');

  // Another device changes the budget, and nothing here sees it.
  const response = await page.request.put(`/api/documents/${budget.id}?base=${budget.updatedAt}`, { data: Buffer.from('Item,Cost\nRent,250\n'), headers: { origin: CLIENT_ORIGIN } });
  expect(response.status(), await response.text()).toBe(200);

  // The next session catches up, with Costs.md never opened.
  await page.goto('/?doc=welcome');
  await expect.poll(() => updatedAt(page, 'Costs.md'), { timeout: 90_000, intervals: [2_000] }).toBeGreaterThan(before);
  expect(await marker(page)).toBeGreaterThan(budget.updatedAt);

  const costs = (await cloudDocs(page)).find((d) => d.name === 'Costs.md')!;
  const app = await openCloud(page, costs.id);
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('250');
  expect(fellBack).toEqual([]);
  await context.close();
});
