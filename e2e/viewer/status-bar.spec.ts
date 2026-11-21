// The site's viewer pages (/view?p=…, src/viewer/share.ts) look like the editor without its editing: a loading screen while the
// file comes, and the editor's status bar under the document (the page, the word count, the zoom with its list of sizes, and
// Print Layout, Flow and Page Grid). The bar at the top keeps the page buttons and the zoom steps; the zoom itself is in the status
// bar. Embedded in another site's page, the viewer stays compact, with no status bar.

import type { Browser, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { CLIENT_ORIGIN } from '../ports.ts';
import { makeDocx, newPerson, signedOutContext, uploadDoc } from '../collab/helpers';

/** A public link to a Word document of `paragraphs`, opened by someone signed out (before the page is visited). */
async function publicDocument(browser: Browser, paragraphs: string[]): Promise<{ page: Page; url: string; close(): Promise<void> }> {
  const owner = await newPerson(browser, 'owner');
  const doc = await uploadDoc(owner.page, 'Plan.docx', await makeDocx(browser, paragraphs));
  const response = await owner.page.request.put(`/api/documents/${doc.id}/link`, { headers: { origin: CLIENT_ORIGIN } });
  const { token } = (await response.json()) as { token: string };
  const stranger = await signedOutContext(browser);
  const page = await stranger.newPage();
  return {
    page,
    url: `/view?p=${token}`,
    close: async () => {
      await stranger.close();
      await owner.context.close();
    },
  };
}

const paragraphs = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1} of the plan, with a few more words.`);

test('the public page shows the status bar: the page, words, zoom sizes and the three views', async ({ browser }) => {
  const { page, url, close } = await publicDocument(browser, paragraphs);
  await page.goto(url);
  const footer = page.locator('.wm-footer');
  await expect(footer).toBeVisible();
  await expect(footer).toContainText(/Page 1 of \d{2}/);
  await expect(footer).toContainText(/[\d,]+ words/);

  // The zoom is in the status bar, not the bar at the top; its list sets a size.
  await expect(page.getByRole('toolbar').getByRole('button', { name: /Actual Size/ })).toHaveCount(0);
  await footer.getByRole('button', { name: /^\d+%$/ }).click();
  await page.getByRole('listbox', { name: 'Zoom' }).getByRole('option', { name: '200%' }).click();
  await expect(footer.getByRole('button', { name: '200%' })).toBeVisible();

  // The views: Flow has no pages (the page buttons go), the grid and Print Layout show them again.
  const views = footer.getByRole('group', { name: 'Views' });
  const print = views.getByRole('button', { name: 'Print Layout' });
  const flow = views.getByRole('button', { name: 'Flow' });
  const grid = views.getByRole('button', { name: 'Page Grid' });
  await expect(print).toHaveAttribute('aria-pressed', 'true');
  await flow.click();
  await expect(flow).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Next Page' })).toBeHidden();
  await expect(footer).not.toContainText('Page 1 of');
  await grid.click();
  await expect(grid).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Next Page' })).toBeVisible();
  await print.click();
  await expect(print).toHaveAttribute('aria-pressed', 'true');
  await expect(footer).toContainText(/Page \d+ of/);

  // In another site's frame there is no status bar, and the zoom is back in the top bar.
  await page.goto(`${url}&embed`);
  await expect(page.getByRole('button', { name: /Actual Size/ })).toBeVisible();
  await expect(page.locator('.wm-footer')).toHaveCount(0);
  await close();
});

test('the public page starts in the view the person chose in the editor', async ({ browser }) => {
  const { page, url, close } = await publicDocument(browser, paragraphs);
  await page.addInitScript(() => localStorage.setItem('word.viewMode', 'flow'));
  await page.goto(url);
  await expect(page.locator('.wm-footer').getByRole('button', { name: 'Flow' })).toHaveAttribute('aria-pressed', 'true');
  await close();
});

test('a file that is slow to come shows the loading screen until it is open', async ({ browser }) => {
  const { page, url, close } = await publicDocument(browser, ['the plan']);
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/public/*/file', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(url);
  const loading = page.locator('.wm-loading');
  await expect(loading).toBeVisible();
  await expect(loading).toContainText('Plan.docx');
  await expect(loading.locator('.wm-loading-box')).toBeVisible();
  release();
  await expect(page.locator('.wm-footer')).toContainText('2 words');
  await expect(page.locator('.wm-loading:visible')).toHaveCount(0);
  await close();
});
