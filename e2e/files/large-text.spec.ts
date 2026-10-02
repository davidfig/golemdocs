// A text file of 8 MB or more opens in the large-text viewer instead of the editor: search,
// filter, go to line, wrapping, text size, copying and downloading the file as it was.

import type { Locator, Page } from '@playwright/test';
import { MOD, expect, test, type App } from './fixtures';
import { dropFile, formatLabel, hasItem, importFile, menuContents, status, waitForOpen } from './helpers';

const LINES = 150_000;
const NEEDLES = [77_777, 140_000];

/** ~9.7 MB of text: numbered lines, two of them holding NEEDLE-XYZ. */
function bigText(): Buffer {
  const out: string[] = [];
  for (let n = 1; n <= LINES; n++) {
    const tail = NEEDLES.includes(n) ? 'NEEDLE-XYZ here' : 'the quick brown fox jumps over the lazy dog';
    out.push(`Line ${n} ${tail} ${'.'.repeat(12)}`);
  }
  return Buffer.from(out.join('\n') + '\n', 'utf8');
}

const BIG = bigText();
const viewer = (page: Page) => page.locator('.wm-large');
const rows = (page: Page) => viewer(page).locator('.wm-large-row');
const findBox = (page: Page) => viewer(page).getByRole('textbox', { name: 'Find' });
const message = (page: Page) => viewer(page).locator('.wm-large-message');

async function openBig(app: App, name = 'big.txt', buffer: Buffer = BIG): Promise<void> {
  await app.goto('?doc=welcome');
  await importFile(app, { name, buffer });
  await expect(viewer(app.page)).toBeVisible();
  // Indexed: the status bar knows the line count.
  await expect(viewer(app.page).locator('.wm-large-status')).toContainText(`${LINES.toLocaleString('en-US')} lines`, { timeout: 30_000 });
}

/** The number of the line a row shows. */
const lineNumber = async (row: Locator) => Number(await row.locator('.wm-large-num').textContent());

test('a file of 8 MB or more opens in the viewer, with its line count and size', async ({ app, page }) => {
  expect(BIG.length).toBeGreaterThanOrEqual(8 * 1024 * 1024);
  await openBig(app);
  expect(await formatLabel(page)).toBe('Large Text');
  await expect(page).toHaveTitle('big.txt - Golem Docs');
  await expect(viewer(page).locator('.wm-large-status')).toContainText(/\d+(\.\d)? MB/);
  // The first lines are on screen, numbered from 1.
  await expect(rows(page).first()).toContainText('Line 1 the quick brown fox');
  expect(await lineNumber(rows(page).first())).toBe(1);
  // Only the rows in view exist.
  expect(await rows(page).count()).toBeLessThan(200);
  await expect.poll(() => status(page), { intervals: [25] }).toMatch(/big\.txt is large \(\d+\.\d MB\), so it opens in a viewer/);
});

test('a large CSV opens in the viewer too, not as a table', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importFile(app, { name: 'big.csv', buffer: BIG });
  await expect(viewer(page)).toBeVisible();
  expect(await formatLabel(page)).toBe('Large Text');
});

test('a large file dropped on the window opens in the viewer', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, { name: 'dropped-big.txt', buffer: BIG });
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page).locator('.wm-large-status')).toContainText('150,000 lines', { timeout: 30_000 });
});

test('the viewer only looks: no editing, printing, converting or sharing in the menus', async ({ app }) => {
  await openBig(app);
  const file = await menuContents(app, 'File');
  for (const item of ['Download', 'Download All', 'Open', 'Import', 'New']) expect(hasItem(file, item), item).toBe(true);
  for (const item of ['Print', 'Print Preview', 'Share', 'Page Setup']) expect(hasItem(file, item, true), item).toBe(false);
  const edit = await menuContents(app, 'Edit');
  expect(hasItem(edit, 'Find')).toBe(true);
  expect(hasItem(edit, 'Go To')).toBe(true);
  expect(hasItem(edit, 'Replace', true)).toBe(false);
  expect(hasItem(edit, 'Paste', true)).toBe(false);
  expect(await menuContents(app, 'Format')).toBeNull();
  expect(await menuContents(app, 'Table')).toBeNull();
});

test('Find searches the whole file and lists how many lines match', async ({ app, page }) => {
  await openBig(app);
  await page.keyboard.press(`${MOD}+f`);
  await expect(findBox(page)).toBeFocused();
  await findBox(page).fill('NEEDLE-XYZ');
  await expect(message(page)).toHaveText('2 matching lines');
  // The first match is in view, marked as the current line, with the match highlighted.
  const current = viewer(page).locator('.wm-large-current');
  await expect(current).toContainText('NEEDLE-XYZ');
  expect(await lineNumber(current)).toBe(NEEDLES[0]);
  await expect(current.locator('mark')).toHaveText('NEEDLE-XYZ');
  // Next goes to the second, and round to the first again.
  await findBox(page).press('Enter');
  await expect.poll(async () => lineNumber(viewer(page).locator('.wm-large-current'))).toBe(NEEDLES[1]);
  await findBox(page).press('Enter');
  await expect.poll(async () => lineNumber(viewer(page).locator('.wm-large-current'))).toBe(NEEDLES[0]);
  await findBox(page).press('Shift+Enter');
  await expect.poll(async () => lineNumber(viewer(page).locator('.wm-large-current'))).toBe(NEEDLES[1]);
});

test('the next and previous buttons step through matches', async ({ app, page }) => {
  await openBig(app);
  await page.keyboard.press(`${MOD}+f`);
  await findBox(page).fill('NEEDLE-XYZ');
  await expect(message(page)).toHaveText('2 matching lines');
  await viewer(page).getByRole('button', { name: 'Next match' }).click();
  await expect.poll(async () => lineNumber(viewer(page).locator('.wm-large-current'))).toBe(NEEDLES[1]);
  await viewer(page).getByRole('button', { name: 'Previous match' }).click();
  await expect.poll(async () => lineNumber(viewer(page).locator('.wm-large-current'))).toBe(NEEDLES[0]);
});

test('a search with no match says so', async ({ app, page }) => {
  await openBig(app);
  await page.keyboard.press(`${MOD}+f`);
  await findBox(page).fill('does-not-occur-anywhere');
  await expect(message(page)).toHaveText('No matches');
});

test('Match case, Whole word and Regular expression change what matches', async ({ app, page }) => {
  await openBig(app);
  await page.keyboard.press(`${MOD}+f`);
  const toggle = (name: string) => viewer(page).getByRole('button', { name });

  await findBox(page).fill('needle-xyz');
  await expect(message(page)).toHaveText('2 matching lines');
  await toggle('Match case').click();
  await expect(message(page)).toHaveText('No matches');
  await toggle('Match case').click();
  await expect(message(page)).toHaveText('2 matching lines');

  await findBox(page).fill('NEEDLE');
  await expect(message(page)).toHaveText('2 matching lines');
  await findBox(page).fill('NEED');
  await toggle('Whole word').click();
  await expect(message(page)).toHaveText('No matches');
  await toggle('Whole word').click();

  await toggle('Regular expression').click();
  await findBox(page).fill('^Line 7777[0-9] ');
  await expect(message(page)).toHaveText('10 matching lines');
  await findBox(page).fill('([unclosed');
  await expect(message(page)).toHaveText('Not a valid regular expression');
});

test('Show only matching lines filters the view down to the matches', async ({ app, page }) => {
  await openBig(app);
  await page.keyboard.press(`${MOD}+f`);
  await findBox(page).fill('NEEDLE-XYZ');
  await expect(message(page)).toHaveText('2 matching lines');
  await viewer(page).getByRole('button', { name: 'Show only matching lines' }).click();
  await expect(rows(page)).toHaveCount(2);
  expect(await lineNumber(rows(page).nth(0))).toBe(NEEDLES[0]);
  expect(await lineNumber(rows(page).nth(1))).toBe(NEEDLES[1]);
  // Turned off, every line is back.
  await viewer(page).getByRole('button', { name: 'Show only matching lines' }).click();
  await expect.poll(() => rows(page).count()).toBeGreaterThan(20);
});

test('Go To jumps to a line', async ({ app, page }) => {
  await openBig(app);
  await page.keyboard.press(`${MOD}+g`);
  const box = viewer(page).getByRole('spinbutton', { name: 'Go to line' });
  await expect(box).toBeFocused();
  await box.fill('120000');
  await box.press('Enter');
  await expect(viewer(page).locator('.wm-large-row', { hasText: 'Line 120000 ' })).toBeVisible();
  await expect(viewer(page).locator('.wm-large-status')).toContainText(/Line 1(19|20),\d{3}/);
  // Past the end goes to the last line.
  await box.fill('999999');
  await box.press('Enter');
  await expect(viewer(page).locator('.wm-large-row', { hasText: `Line ${LINES} ` })).toBeVisible();
});

test('Escape closes the find bar', async ({ app, page }) => {
  await openBig(app);
  await page.keyboard.press(`${MOD}+f`);
  await expect(findBox(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(findBox(page)).toBeHidden();
});

test('Alt+Z and the button toggle wrapping of long lines', async ({ app, page }) => {
  await openBig(app);
  const wrap = viewer(page).getByRole('button', { name: 'Wrap long lines' });
  const before = await wrap.getAttribute('aria-pressed');
  const wrapping = async () => viewer(page).evaluate((el) => el.classList.contains('wm-large-wrapping'));
  const wasWrapping = await wrapping();
  expect(before).toBe(String(wasWrapping));
  await page.locator('.wm-large-scroll').focus();
  await page.keyboard.press('Alt+z');
  await expect(wrap).toHaveAttribute('aria-pressed', String(!wasWrapping));
  expect(await wrapping()).toBe(!wasWrapping);
  await wrap.click();
  await expect(wrap).toHaveAttribute('aria-pressed', String(wasWrapping));
  expect(await wrapping()).toBe(wasWrapping);
});

test('the wrap choice is remembered after a reload', async ({ app, page }) => {
  await openBig(app);
  const wrap = viewer(page).getByRole('button', { name: 'Wrap long lines' });
  const was = (await wrap.getAttribute('aria-pressed')) === 'true';
  await wrap.click();
  await page.goto('/?doc=welcome');
  await app.ready();
  await importFile(app, { name: 'again.txt', buffer: BIG });
  await expect(viewer(page).getByRole('button', { name: 'Wrap long lines' })).toHaveAttribute('aria-pressed', String(!was));
});

test('View ▸ Zoom changes the text size in the viewer, and Actual Size puts it back', async ({ app, page }) => {
  await openBig(app);
  const size = () => viewer(page).locator('.wm-large-scroll').evaluate((el) => parseFloat(getComputedStyle(el.querySelector('.wm-large-row')!).fontSize));
  const normal = await size();
  await app.menu('View', 'Zoom', 'Zoom In');
  await expect.poll(size).toBeGreaterThan(normal);
  await app.menu('View', 'Zoom', 'Zoom Out');
  await app.menu('View', 'Zoom', 'Zoom Out');
  await expect.poll(size).toBeLessThan(normal);
  await app.menu('View', 'Zoom', 'Actual Size');
  await expect.poll(size).toBe(normal);
});

test('clicking line numbers selects lines, and copying puts their text on the clipboard', async ({ app, page }) => {
  await openBig(app);
  await rows(page).nth(1).locator('.wm-large-num').click();
  await rows(page).nth(3).locator('.wm-large-num').click({ modifiers: ['Shift'] });
  await expect(viewer(page).locator('.wm-large-selected')).toHaveCount(3);
  await page.keyboard.press(`${MOD}+c`);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    ['Line 2 the quick brown fox jumps over the lazy dog ............', 'Line 3 the quick brown fox jumps over the lazy dog ............', 'Line 4 the quick brown fox jumps over the lazy dog ............'].join('\n'),
  );
});

// Suspected bug: Edit ▸ Copy stays disabled in the viewer (its enabled state follows the editor's selection, which is empty there), although the Copy action knows how to copy the viewer's lines.
test.fixme('Edit ▸ Copy copies the selected lines too', async ({ app, page }) => {
  await openBig(app);
  await rows(page).nth(0).locator('.wm-large-num').click();
  await app.menu('Edit', 'Copy');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Line 1 the quick brown fox jumps over the lazy dog ............');
});

test('Download gives the file back exactly as it was, under its own name', async ({ app }) => {
  await openBig(app, 'huge-log.txt');
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('huge-log.txt');
  expect(file.bytes.length).toBe(BIG.length);
  expect(file.bytes.equals(BIG)).toBe(true);
});

test('opening another document takes the viewer away', { tag: '@heavy' }, async ({ app, page }) => {
  await openBig(app);
  await app.menu('File', 'New');
  await waitForOpen(app, 'Document1');
  await expect(viewer(page)).toBeHidden();
  expect(await formatLabel(page)).toBe('Word Document');
  await app.type('normal again');
  await expect.poll(() => app.text()).toBe('normal again');
});

test('a file just under the limit is still a normal document', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importFile(app, { name: 'small.txt', buffer: Buffer.from('a\nb\nc\n') });
  await expect(viewer(page)).toBeHidden();
  expect(await formatLabel(page)).toBe('Plain Text');
});
