// Dragging a document from the Files sidebar onto the open one makes a link to it where it is dropped (`[[alpha]]` in Markdown),
// in documents that can hold links; a plain text document takes nothing.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { importFile, text, waitForSaved } from './helpers';

const row = (page: Page, name: string) => page.locator('.wm-files .wm-files-file', { hasText: name });

/** Where the page is on the screen, for a drop. */
const onPage = async (page: Page) => {
  const box = (await page.locator('#viewport canvas').first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + 120 };
};

test('a document dropped on a Markdown note becomes a link to it, and a plain text document takes none', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  for (const file of [text('alpha.md', '# Alpha'), text('plain.txt', 'just text'), text('beta.md', 'Start here.')]) {
    await importFile(app, file);
    await waitForSaved(page, file.name);
  }
  await app.menu('View', 'Files Sidebar');

  // beta.md is open: drop alpha on its page.
  const at = await onPage(page);
  await row(page, 'alpha').dragTo(page.locator('#viewport canvas').first(), { targetPosition: { x: at.x, y: 120 } });
  await expect.poll(() => app.text()).toContain('alpha');
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.text).toContain('[[alpha]]');

  // A plain text document can't hold a link.
  await row(page, 'plain').click();
  await expect.poll(() => app.text()).toContain('just text');
  await row(page, 'alpha').dragTo(page.locator('#viewport canvas').first(), { targetPosition: { x: at.x, y: 120 } });
  expect(await app.text()).not.toContain('alpha');
});
