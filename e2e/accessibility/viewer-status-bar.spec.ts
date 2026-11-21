// The site viewer's status bar (src/viewer/viewer.ts with `statusBar`, the editor's ui/footer.ts) from the keyboard and with a screen
// reader: Tab reaches it after the document, the views are a named group of buttons that say which is pressed, and the zoom opens a
// named list of sizes that the keyboard can work.

import { test, expect } from '../fixtures';
import { CLIENT_ORIGIN } from '../ports.ts';
import { makeDocx, newPerson, signedOutContext, uploadDoc } from '../collab/helpers';

test('the viewer’s status bar is reached with Tab, and its views and zoom work from the keyboard', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  const doc = await uploadDoc(owner.page, 'Plan.docx', await makeDocx(browser, ['the plan', 'and more of it']));
  const { token } = (await (await owner.page.request.put(`/api/documents/${doc.id}/link`, { headers: { origin: CLIENT_ORIGIN } })).json()) as { token: string };
  const stranger = await signedOutContext(browser);
  const page = await stranger.newPage();
  await page.goto(`/view?p=${token}`);

  const footer = page.locator('.wm-footer');
  const views = footer.getByRole('group', { name: 'Views' });
  for (const name of ['Print Layout', 'Flow', 'Page Grid']) await expect(views.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', /true|false/);
  // The page is a button named by what it says, with Go To as its tooltip (as in the editor).
  const pageButton = footer.getByRole('button', { name: /^Page 1 of/ });
  await expect(pageButton).toHaveAttribute('title', 'Go To…');

  // From the document, Tab goes on into the status bar: the page (Go To), the zoom, then the views.
  await page.locator('.wm-viewer canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Tab');
  await expect(pageButton).toBeFocused();
  // The page opens Go To: here the page field in the bar.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Page number' })).toBeFocused();

  await footer.getByRole('button', { name: /^\d+%$/ }).focus();
  await page.keyboard.press('Enter');
  const list = page.getByRole('listbox', { name: 'Zoom' });
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();

  await page.keyboard.press('Tab');
  await expect(views.getByRole('button', { name: 'Print Layout' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(views.getByRole('button', { name: 'Flow' })).toHaveAttribute('aria-pressed', 'true');
  await stranger.close();
  await owner.context.close();
});
