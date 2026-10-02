// Folders in a signed-in account: they are kept in the account, and stay put as the dashboard lists again.

import { expect, test } from '../fixtures';
import { cloudDocs, makeDocx, newPerson, uploadDoc, waitForCloudDoc } from './helpers';

test('moving documents into a folder keeps them there as the dashboard refreshes, and after a reload', async ({ browser }) => {
  const person = await newPerson(browser, 'folders');
  const { page, app } = person;
  const bytes = await makeDocx(browser, ['hello']);
  await page.goto('/?doc=welcome');
  await app.ready();
  await uploadDoc(page, 'one.docx', bytes);
  await uploadDoc(page, 'two.docx', bytes);

  await app.menu('File', 'Open…');
  const dashboard = page.locator('.wm-dashboard');
  const cards = dashboard.locator('article.wm-card:not(.wm-folder)');
  await expect(cards).toHaveCount(2);

  await dashboard.getByRole('button', { name: 'New folder', exact: true }).click();
  const field = dashboard.getByRole('textbox', { name: 'Folder name' });
  await field.fill('Work');
  await field.press('Enter');
  const folder = dashboard.locator('article.wm-folder').filter({ hasText: 'Work' });
  await expect(folder).toHaveCount(1);

  for (const name of ['one.docx', 'two.docx']) await cards.filter({ hasText: name }).dragTo(folder);
  await expect(folder.locator('.wm-card-meta')).toHaveText('2 items');
  await expect(cards).toHaveCount(0);

  // Give any refresh in flight time to land: nothing should come back out of the folder.
  await page.waitForTimeout(3000);
  await expect(folder.locator('.wm-card-meta')).toHaveText('2 items');
  await expect(cards).toHaveCount(0);

  await page.reload();
  await app.menu('File', 'Open…');
  await expect(dashboard.locator('article.wm-folder').filter({ hasText: 'Work' }).locator('.wm-card-meta')).toHaveText('2 items');
  await expect(cards).toHaveCount(0);
  await person.context.close();
});

test('documents made in the app (with a copy in this browser) stay in their folder as the dashboard refreshes', { tag: '@heavy' }, async ({ browser }) => {
  const person = await newPerson(browser, 'folders');
  const { page, app } = person;
  await app.goto('?doc=welcome');
  for (const words of ['first', 'second']) {
    await app.blank();
    await app.type(words);
    await expect.poll(async () => (await cloudDocs(page)).length, { timeout: 30_000 }).toBeGreaterThan(words === 'first' ? 0 : 1);
    await expect(page.locator('.wm-sync')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
  }
  await waitForCloudDoc(page);

  await app.menu('File', 'Open…');
  const dashboard = page.locator('.wm-dashboard');
  const cards = dashboard.locator('article.wm-card:not(.wm-folder)');
  await expect(cards).toHaveCount(2);
  await dashboard.getByRole('button', { name: 'New folder', exact: true }).click();
  const field = dashboard.getByRole('textbox', { name: 'Folder name' });
  await field.fill('Work');
  await field.press('Enter');
  const folder = dashboard.locator('article.wm-folder').filter({ hasText: 'Work' });
  await expect(folder).toHaveCount(1);

  await cards.first().dragTo(folder);
  await expect(cards).toHaveCount(1);
  await cards.first().dragTo(folder);
  await expect(folder.locator('.wm-card-meta')).toHaveText('2 items');

  await page.waitForTimeout(4000);
  await expect(folder.locator('.wm-card-meta')).toHaveText('2 items');
  await expect(cards).toHaveCount(0);
  await person.context.close();
});

test('if the folders can’t be listed during a refresh, the ones on screen stay (and so do their documents)', async ({ browser }) => {
  const person = await newPerson(browser, 'folders');
  const { page, app } = person;
  const bytes = await makeDocx(browser, ['hello']);
  await page.goto('/?doc=welcome');
  await app.ready();
  await uploadDoc(page, 'one.docx', bytes);
  await app.menu('File', 'Open…');
  const dashboard = page.locator('.wm-dashboard');
  const cards = dashboard.locator('article.wm-card:not(.wm-folder)');
  await dashboard.getByRole('button', { name: 'New folder', exact: true }).click();
  const field = dashboard.getByRole('textbox', { name: 'Folder name' });
  await field.fill('Work');
  await field.press('Enter');
  await cards.first().dragTo(dashboard.locator('article.wm-folder').filter({ hasText: 'Work' }));
  await expect(cards).toHaveCount(0);

  // The folders fail to load on the next refresh, which a rename causes.
  await page.route('**/api/folders', (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 500, body: '{}' }) : route.continue()));
  const folder = dashboard.locator('article.wm-folder').filter({ hasText: 'Work' });
  await folder.hover();
  await folder.getByRole('button', { name: 'Rename' }).click();
  await field.fill('Work 2');
  await field.press('Enter');
  await page.waitForTimeout(1500);
  await expect(dashboard.locator('article.wm-folder').filter({ hasText: 'Work 2' }).locator('.wm-card-meta')).toHaveText('1 item');
  await expect(cards).toHaveCount(0);
  await person.context.close();
});
