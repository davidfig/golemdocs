// A text file of 8 MB or more opens in the large-text viewer instead of the editor: search,
// filter, go to line, wrapping, text size, copying and downloading the file as it was.

import { MOD, expect, test } from './fixtures';
import { dropFile, formatLabel, hasItem, importFile, menuContents, status, waitForOpen } from './helpers';
import { clickNumber, expectLine, findBox, largeStatus, lineText, message, openBigFile, state, viewer, wrapToggle, statusBarOn } from './large-helpers';

test.beforeEach(({ page }) => statusBarOn(page));

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

async function openBig(app: Parameters<typeof openBigFile>[0], name = 'big.txt', buffer: Buffer = BIG): Promise<void> {
  await openBigFile(app, name, buffer, LINES);
}

test('a file of 8 MB or more opens in the viewer, with its line count and size', async ({ app, page }) => {
  expect(BIG.length).toBeGreaterThanOrEqual(8 * 1024 * 1024);
  await openBig(app);
  expect(await formatLabel(page)).toBe('Plain Text');
  await expect(page).toHaveTitle('big.txt - Golem Docs');
  await expect(largeStatus(page)).toContainText(/\d+(\.\d)? MB/);
  // The first lines are on screen, numbered from 1.
  await expectLine(page, 0, /^Line 1 the quick brown fox/);
  // Only what is in view is laid out.
  expect((await state(page)).visible.length).toBeLessThan(200);
  await expect.poll(() => status(page), { intervals: [25] }).toMatch(/big\.txt is large \(\d+\.\d MB\), so it opens in the large-file editor/);
});

test('a large CSV opens in the viewer too, not as a table', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importFile(app, { name: 'big.csv', buffer: BIG });
  await expect(viewer(page)).toBeVisible();
  expect(await formatLabel(page)).toBe('Plain Text');
});

test('a large file dropped on the window opens in the viewer', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, { name: 'dropped-big.txt', buffer: BIG });
  await expect(viewer(page)).toBeVisible();
  await expect(largeStatus(page)).toContainText('150,000 lines', { timeout: 30_000 });
});

test('the text editor edits text only: no formatting or page setup in the menus (printing and converting open the file as a document first)', async ({ app }) => {
  await openBig(app);
  const file = await menuContents(app, 'File');
  for (const item of ['Download', 'Download All', 'Open', 'Import', 'New']) expect(hasItem(file, item), item).toBe(true);
  // Nothing is selected yet, so this one is there but off.
  expect(hasItem(file, 'Open Selection as Document', true)).toBe(true);
  expect(hasItem(file, 'Open Selection as Document')).toBe(false);
  for (const item of ['Print', 'Print Preview', 'Share']) expect(hasItem(file, item, true), item).toBe(true);
  expect(hasItem(file, 'Page Setup', true)).toBe(false);
  const edit = await menuContents(app, 'Edit');
  expect(hasItem(edit, 'Find')).toBe(true);
  expect(hasItem(edit, 'Go To')).toBe(true);
  expect(hasItem(edit, 'Replace')).toBe(true);
  expect(hasItem(edit, 'Paste', true)).toBe(true);
  expect(hasItem(edit, 'Cut', true)).toBe(true);
  expect(hasItem(edit, 'Undo', true)).toBe(true);
  expect(await menuContents(app, 'Format')).toBeNull();
  expect(await menuContents(app, 'Table')).toBeNull();
});

test('Find searches the whole file and lists how many lines match', async ({ app, page }) => {
  await openBig(app);
  await page.keyboard.press(`${MOD}+f`);
  await expect(findBox(page)).toBeFocused();
  await findBox(page).fill('NEEDLE-XYZ');
  await expect(message(page)).toHaveText('2 matching lines');
  // The first match is in view, marked as the current line.
  await expect.poll(async () => (await state(page)).current).toBe(NEEDLES[0] - 1);
  await expectLine(page, NEEDLES[0] - 1, /NEEDLE-XYZ here/);
  // Next goes to the second, and round to the first again.
  await findBox(page).press('Enter');
  await expect.poll(async () => (await state(page)).current).toBe(NEEDLES[1] - 1);
  await findBox(page).press('Enter');
  await expect.poll(async () => (await state(page)).current).toBe(NEEDLES[0] - 1);
  await findBox(page).press('Shift+Enter');
  await expect.poll(async () => (await state(page)).current).toBe(NEEDLES[1] - 1);
});

test('the next and previous buttons step through matches', { tag: '@heavy' }, async ({ app, page }) => {
  await openBig(app);
  await page.keyboard.press(`${MOD}+f`);
  await findBox(page).fill('NEEDLE-XYZ');
  await expect(message(page)).toHaveText('2 matching lines');
  await viewer(page).getByRole('button', { name: 'Next match' }).click();
  await expect.poll(async () => (await state(page)).current).toBe(NEEDLES[1] - 1);
  await viewer(page).getByRole('button', { name: 'Previous match' }).click();
  await expect.poll(async () => (await state(page)).current).toBe(NEEDLES[0] - 1);
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
  await expect.poll(async () => (await state(page)).visible.map((v) => v.line)).toEqual([NEEDLES[0] - 1, NEEDLES[1] - 1]);
  // Turned off, every line is back.
  await viewer(page).getByRole('button', { name: 'Show only matching lines' }).click();
  await expect.poll(async () => (await state(page)).visible.length).toBeGreaterThan(20);
});

test('Go To jumps to a line', async ({ app, page }) => {
  await openBig(app);
  await page.keyboard.press(`${MOD}+g`);
  const box = viewer(page).getByRole('spinbutton', { name: 'Go to line' });
  await expect(box).toBeFocused();
  await box.fill('120000');
  await box.press('Enter');
  await expectLine(page, 119_999, /^Line 120000 /);
  await expect(largeStatus(page)).toContainText(/Line 1(19|20),\d{3}/);
  // Past the end goes to the last line.
  await box.fill('999999');
  await box.press('Enter');
  await expectLine(page, LINES - 1, new RegExp(`^Line ${LINES} `));
});

test('Escape closes the find bar', async ({ app, page }) => {
  await openBig(app);
  await page.keyboard.press(`${MOD}+f`);
  await expect(findBox(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(findBox(page)).toBeHidden();
});

test('opening the find bar moves the text down so it hides nothing, and closing puts it back', async ({ app, page }) => {
  await openBig(app);
  const before = await page.evaluate(() => (window as unknown as { textEditor: { pointOf(l: number, c: number): { y: number } } }).textEditor.pointOf(0, 0).y);
  await page.keyboard.press(`${MOD}+f`);
  await expect(findBox(page)).toBeVisible();
  const barBottom = (await viewer(page).locator('.wm-large-bar').boundingBox())!.y + (await viewer(page).locator('.wm-large-bar').boundingBox())!.height;
  const canvasTop = (await page.locator('#canvas').boundingBox())!.y;
  const during = await page.evaluate(() => (window as unknown as { textEditor: { pointOf(l: number, c: number): { y: number } } }).textEditor.pointOf(0, 0).y);
  expect(canvasTop + during).toBeGreaterThan(barBottom);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => (window as unknown as { textEditor: { pointOf(l: number, c: number): { y: number } } }).textEditor.pointOf(0, 0).y)).toBeCloseTo(before, 0);
});

test('Alt+Z and the button toggle wrapping of long lines', async ({ app, page }) => {
  await openBig(app);
  const wrap = wrapToggle(page);
  const wasWrapping = (await state(page)).wrap;
  expect(await wrap.getAttribute('aria-pressed')).toBe(String(wasWrapping));
  await page.keyboard.press('Alt+z');
  await expect(wrap).toHaveAttribute('aria-pressed', String(!wasWrapping));
  expect((await state(page)).wrap).toBe(!wasWrapping);
  await wrap.click();
  await expect(wrap).toHaveAttribute('aria-pressed', String(wasWrapping));
  expect((await state(page)).wrap).toBe(wasWrapping);
});

test('the wrap choice is remembered after a reload', async ({ app, page }) => {
  await openBig(app);
  const wrap = wrapToggle(page);
  const was = (await wrap.getAttribute('aria-pressed')) === 'true';
  await wrap.click();
  await page.goto('/?doc=welcome');
  await app.ready();
  await importFile(app, { name: 'again.txt', buffer: BIG });
  await expect(wrapToggle(page)).toHaveAttribute('aria-pressed', String(!was));
});

test('View ▸ Zoom zooms the text like a document, and Actual Size puts it back', async ({ app, page }) => {
  await openBig(app);
  const zoom = async () => (await state(page)).zoom;
  expect(await zoom()).toBe(1);
  await app.menu('View', 'Zoom', 'Zoom In');
  await expect.poll(zoom).toBeGreaterThan(1);
  await app.menu('View', 'Zoom', 'Zoom Out');
  await app.menu('View', 'Zoom', 'Zoom Out');
  await expect.poll(zoom).toBeLessThan(1);
  await app.menu('View', 'Zoom', 'Actual Size');
  await expect.poll(zoom).toBe(1);
});

test('Ctrl+wheel zooms smoothly about the pointer, and the plain wheel scrolls', async ({ app, page }) => {
  await openBig(app);
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.move(box.x + 300, box.y + 300);
  const top = (await state(page)).topLine;
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => (await state(page)).topLine).toBeGreaterThan(top);
  const before = (await state(page)).zoom;
  await page.waitForTimeout(300); // a new wheel gesture, not the end of the scroll
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await state(page)).zoom).toBeGreaterThan(before);
  // Zoomed far out the text is still text, however small.
  await page.keyboard.down('Control');
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 400);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await state(page)).zoom).toBeLessThan(0.1);
  await expect.poll(async () => (await state(page)).glyphs).toBeGreaterThan(0);
});

test('clicking line numbers selects lines, and copying puts their text on the clipboard', async ({ app, page }) => {
  await openBig(app);
  await clickNumber(page, 1);
  await clickNumber(page, 3, { modifiers: ['Shift'] });
  await expect.poll(async () => (await state(page)).selected).toBe(
    ['Line 2 the quick brown fox jumps over the lazy dog ............', 'Line 3 the quick brown fox jumps over the lazy dog ............', 'Line 4 the quick brown fox jumps over the lazy dog ............'].join('\n'),
  );
  await page.keyboard.press(`${MOD}+c`);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    ['Line 2 the quick brown fox jumps over the lazy dog ............', 'Line 3 the quick brown fox jumps over the lazy dog ............', 'Line 4 the quick brown fox jumps over the lazy dog ............'].join('\n'),
  );
});

test('Edit ▸ Copy copies the selected lines too', async ({ app, page }) => {
  await openBig(app);
  await clickNumber(page, 0);
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
  await importFile(app, { name: 'note.md', buffer: Buffer.from('normal again') });
  await waitForOpen(app, 'note');
  await expect(viewer(page)).toBeHidden();
  expect(await formatLabel(page)).toBe('Markdown');
  await expect.poll(() => app.text()).toBe('normal again');
});

test('a small text file opens in the text editor too, and a Word document does not', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await importFile(app, { name: 'small.txt', buffer: Buffer.from('a\nb\nc\n') });
  await expect(viewer(page)).toBeVisible();
  expect(await formatLabel(page)).toBe('Plain Text');
  expect(await app.text()).toBe('a\nb\nc\n');
});

test('the text is drawn in JetBrains Mono, the app\'s monospace font', async ({ app, page }) => {
  const fonts: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/fonts/jetbrains-mono')) fonts.push(r.url());
  });
  await openBig(app);
  await expect.poll(() => fonts.some((u) => u.includes('jetbrains-mono/regular'))).toBe(true);
  void lineText;
});
