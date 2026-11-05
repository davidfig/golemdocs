// When the export took too long for the share sheet to be allowed: one more tap opens it, and nothing is claimed to have been saved before that.

import { expect, test } from './fixtures';
import { IPHONE, drawerItem, sharedFiles, stubShareSheet } from './helpers';

test.use(IPHONE);

test.beforeEach(async ({ app, page }) => {
  await stubShareSheet(page, 1);
  await app.goto('?doc=welcome');
});

for (const [item, name] of [[/^Download(\s|$)/, '.docx'], [/^Print/, '.pdf']] as const) {
  test(`a refused sheet asks for a tap, and Save opens it (${item.source})`, async ({ page }) => {
    await drawerItem(page, item);
    const dialog = page.getByRole('dialog').filter({ hasText: 'Your file is ready' });
    await expect(dialog).toContainText(name);
    expect((await sharedFiles(page)).map((f) => f.refused)).toEqual([true]);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect.poll(async () => (await sharedFiles(page)).map((f) => f.refused)).toEqual([true, false]);
    await expect(dialog).toHaveCount(0);
  });
}

test('Cancel leaves it, with no sheet and no download', async ({ page }) => {
  let downloaded = false;
  page.on('download', () => (downloaded = true));
  await drawerItem(page, /^Download(\s|$)/);
  const dialog = page.getByRole('dialog').filter({ hasText: 'Your file is ready' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await sharedFiles(page)).toHaveLength(1);
  expect(downloaded).toBe(false);
});
