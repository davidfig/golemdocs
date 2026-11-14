// The embeddable viewer and the site's view-only page with a screen reader (docs/architecture/accessibility.md, "The viewer"):
// its parts are landmarks with names, its controls are named and reached from the keyboard, Find's result is said, and its
// Screen Reader Mode (the first thing Tab reaches, Mod+Alt+Z, or the host asking) gives the pages a reading layer and the
// textarea the text around a caret the arrows move.

import { expect, test, type Page } from '@playwright/test';
import { CLIENT_ORIGIN } from '../ports';
import { docxFile, hostPage, ViewerHost } from '../viewer/helpers';

const MOD = 'ControlOrMeta';

async function host(page: Page, screenReader = false): Promise<ViewerHost> {
  const body = hostPage('/viewer.html').replace("dark: false }", `dark: false, screenReader: ${screenReader} }`);
  await page.route(`${CLIENT_ORIGIN}/viewer-host.html`, (route) => route.fulfill({ contentType: 'text/html', body }));
  const viewer = new ViewerHost(page);
  await page.goto('/viewer-host.html');
  return viewer;
}

test('the viewer has a named toolbar, a main region named for the document, its language and title, and named controls', async ({ page }) => {
  const viewer = await host(page);
  await viewer.open('Report.docx', await docxFile(3));
  const frame = viewer.frame;
  await expect(frame.locator('html')).toHaveAttribute('lang', 'en');
  expect(await page.frames()[1].title()).toBe('Report.docx');
  await expect(frame.getByRole('main', { name: 'Report.docx' })).toHaveCount(1);
  const toolbar = frame.getByRole('toolbar', { name: 'Viewer' });
  for (const name of ['Previous Page', 'Next Page', 'Zoom Out', 'Actual Size (now 100%)', 'Zoom In', 'Find']) await expect(toolbar.getByRole('button', { name, exact: true })).toHaveCount(1);
  await expect(toolbar.getByRole('textbox', { name: 'Page number' })).toHaveCount(1);
  // Without Screen Reader Mode the document's textarea says how to turn it on.
  await expect(frame.locator('.wm-viewer-input')).toHaveAttribute('aria-description', /Screen Reader Mode/);
  await expect(frame.locator('.wm-reading-page')).toHaveCount(0);

  // Tab reaches the Screen Reader Mode button first, then the toolbar, whose arrow keys move between its buttons.
  const mode = frame.getByRole('button', { name: 'Screen Reader Mode' });
  await expect(frame.locator('.wm-viewer > :first-child')).toHaveAccessibleName('Screen Reader Mode');
  await mode.focus();
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Tab');
  await expect(toolbar.getByRole('button', { name: 'Previous Page' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(toolbar.getByRole('button', { name: 'Next Page' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toolbar.getByRole('textbox', { name: 'Page number' })).toHaveValue('2');
});

test('Find says where it found the text', async ({ page }) => {
  const viewer = await host(page);
  await viewer.open('Report.docx', await docxFile(3));
  await viewer.frame.locator('canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(`${MOD}+f`);
  const query = viewer.frame.getByRole('search', { name: 'Find' }).getByRole('searchbox');
  await query.fill('Page 3');
  await query.press('Enter');
  await expect(viewer.frame.locator('.wm-sr-only[aria-live="polite"]')).toHaveText('Found on page 3 of 3');
});

test('Screen Reader Mode: the reading layer has the pages, the arrows move a caret the textarea follows, and Mod+Alt+Z turns it off', async ({ page }) => {
  const viewer = await host(page);
  await viewer.open('Report.docx', await docxFile(3));
  const frame = viewer.frame;
  const mode = frame.getByRole('button', { name: 'Screen Reader Mode' });
  await mode.focus();
  await page.keyboard.press('Enter');
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.locator('.wm-sr-only[aria-live="assertive"]')).toHaveText('Screen Reader Mode on');
  const layer = frame.getByRole('document', { name: 'Report.docx' });
  await expect(layer.locator('section[aria-label="Page 1"] p')).toHaveText('Page 1 of the report');
  await expect(frame.locator('canvas')).toHaveAttribute('aria-hidden', 'true');

  const input = frame.locator('.wm-viewer-input');
  const mirror = () => input.evaluate((el: HTMLTextAreaElement) => ({ value: el.value, start: el.selectionStart, end: el.selectionEnd }));
  // The caret starts at the text at the top of the view.
  await expect.poll(mirror).toEqual({ value: 'Page 1 of the report', start: 0, end: 0 });
  await input.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(mirror).toEqual({ value: 'Page 1 of the report', start: 1, end: 1 });
  await page.keyboard.press('Shift+End');
  await expect.poll(mirror).toEqual({ value: 'Page 1 of the report', start: 1, end: 20 });
  // On to the next page: it is said, and the view follows.
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => mirror().then((m) => m.value)).toBe('Page 2 of the report');
  await expect(frame.locator('.wm-sr-only[aria-live="polite"]')).toHaveText('Page 2 of 3');
  await expect(frame.getByRole('textbox', { name: 'Page number' })).toHaveValue('2');
  // Typing changes nothing.
  const before = await mirror();
  await page.keyboard.type('xy');
  await page.waitForTimeout(100);
  expect(await mirror()).toEqual(before);

  // Found text is said with the words around it.
  await page.keyboard.press(`${MOD}+f`);
  const query = frame.getByRole('search', { name: 'Find' }).getByRole('searchbox');
  await query.fill('3 of the');
  await query.press('Enter');
  await expect(frame.locator('.wm-sr-only[aria-live="polite"]')).toHaveText(/^Found: Page 3 of the report/);

  await input.focus();
  await page.keyboard.press(`${MOD}+Alt+z`);
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await expect(frame.locator('.wm-reading')).toBeHidden();
  await expect.poll(() => mirror().then((m) => m.value)).toBe('');
});

test('a host can start the viewer in Screen Reader Mode', async ({ page }) => {
  const viewer = await host(page, true);
  await viewer.open('Report.docx', await docxFile(2));
  await expect(viewer.frame.getByRole('button', { name: 'Screen Reader Mode' })).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.frame.locator('.wm-reading-page p').first()).toHaveText('Page 1 of the report');
});

test('in Windows contrast themes the reading layer stays invisible over the pages', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  const viewer = await host(page, true);
  await viewer.open('Report.docx', await docxFile(1));
  const piece = viewer.frame.locator('.wm-reading-page p').first();
  await expect(piece).toHaveText('Page 1 of the report');
  expect(await piece.evaluate((el) => getComputedStyle(el).color)).toBe('rgba(0, 0, 0, 0)');
});
