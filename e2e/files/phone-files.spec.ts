// Getting a file out of a phone: Download and Print both end in the system share sheet, whose Print has every page of the PDF (a frame
// on iOS prints only the first, and an app's web view ignores a download link). The sheet is only allowed just after a tap, so an
// export that took longer asks for one more (`saveFile` in ui/saveFile.ts).

import { expect, test } from './fixtures';
import { IPHONE, drawerItem, sharedFiles, stubShareSheet } from './helpers';

test.use(IPHONE);

test.beforeEach(async ({ app, page }) => {
  await stubShareSheet(page);
  await app.goto('?doc=welcome');
});

test('Print hands the whole document to the share sheet as a PDF, not to a hidden frame', async ({ page }) => {
  await drawerItem(page, /^Print/);
  await expect.poll(() => sharedFiles(page)).toEqual([{ name: expect.stringMatching(/\.pdf$/), type: 'application/pdf', head: '%PDF-', refused: false }]);
  await expect(page.locator('iframe[src^="blob:"]')).toHaveCount(0);
});

test('Download hands the file to the share sheet', async ({ page }) => {
  await drawerItem(page, /^Download(\s|$)/);
  await expect.poll(() => sharedFiles(page)).toEqual([{ name: expect.stringMatching(/\.docx$/), type: expect.stringContaining('wordprocessingml'), head: expect.stringMatching(/^PK/), refused: false }]);
});
