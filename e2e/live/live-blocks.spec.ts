// Live blocks (docs/live-blocks.md): a note that embeds a spreadsheet's rows shows them as a table, kept in the note's file
// between comment markers, and brought up to date when the note is opened.

import type { Page } from '@playwright/test';
import { expect, test } from '../files/fixtures';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildZip, dropFile, status, waitForOpen } from '../files/helpers';
import { decodePdf, makePdf } from '../pdf/helpers';

const dashboard = (page: Page) => page.locator('.wm-dashboard');

async function importVault(app: { goto(url: string): Promise<void>; menu(...path: string[]): Promise<void> }, page: Page, files: { name: string; data: string | Buffer }[]): Promise<void> {
  const zip = buildZip([{ name: 'Vault/', data: '' }, ...files.map((f) => ({ name: `Vault/${f.name}`, data: f.data }))]);
  await app.goto('?doc=welcome');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.menu('File', 'Import…')]);
  await chooser.setFiles({ name: 'vault.zip', mimeType: 'application/zip', buffer: zip });
  await expect.poll(() => status(page)).toBe(`Imported documents: ${files.length}`);
}

test('a note embedding a CSV shows its rows, and saves them between live block markers', async ({ app, page }) => {
  await importVault(app, page, [
    { name: 'Meals.csv', data: 'Day,Calories\nMon,2100\nTue,1900\n' },
    { name: 'Plan.md', data: 'This week:\n\n![[Meals.csv]]\n\nThat is all.\n' },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Plan.md' }).click();

  // Opening the note fills the block from the CSV.
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('Tue');
  const text = await app.text();
  expect(text).toContain('Calories');
  expect(text).toContain('2100');

  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.text).toMatch(/This week:\n\n<!-- golem:live Meals\.csv by=[0-9a-f]{24} stamp=[0-9a-f]{8} -->\n\n\| Day \| Calories \|\n\| --- \| ---: \|\n\| Mon \| 2100 \|\n\| Tue \| 1900 \|\n\n<!-- \/golem:live -->\n\nThat is all\./);
});

test('a live block cannot be typed in, and says where to change it', async ({ app, page }) => {
  await importVault(app, page, [
    { name: 'Meals.csv', data: 'Day,Calories\nMon,2100\n' },
    { name: 'Plan.md', data: 'This week:\n\n![[Meals.csv]]\n\nThat is all.\n' },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Plan.md' }).click();
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('2100');

  // Into the table's first cell, and type: nothing changes, and the status bar says where the table comes from.
  await app.focus();
  await app.press('ControlOrMeta+Home');
  await app.press('ArrowDown');
  await app.type('Z');
  await expect.poll(() => status(page)).toContain('Meals.csv');
  expect(await app.text()).not.toContain('Z');
  // Outside it, typing works as ever.
  await app.press('ControlOrMeta+End');
  await app.type(' Done.');
  await expect.poll(() => app.text()).toContain('That is all. Done.');
});

test('a live block\'s card names its source, updates it, and opens it', async ({ app, page }) => {
  await importVault(app, page, [
    { name: 'Meals.csv', data: 'Day,Calories\nMon,2100\n' },
    { name: 'Plan.md', data: 'This week:\n\n![[Meals.csv]]\n\nThat is all.\n' },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Plan.md' }).click();
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('2100');

  const card = page.getByRole('dialog', { name: 'Live Block' });
  await app.focus();
  await app.press('ControlOrMeta+Home');
  await expect(card).toBeHidden();
  await app.press('ArrowDown');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Meals.csv');
  // Escape puts it away; it stays away while the caret is in the same block, and leaving the block hides it.
  await app.press('Escape');
  await expect(card).toBeHidden();
  await app.press('ArrowRight');
  await expect(card).toBeHidden();
  await app.press('ControlOrMeta+End');
  await app.press('ControlOrMeta+Home');
  await app.press('ArrowDown');
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Update Now' }).click();
  await expect.poll(() => status(page)).toBe('Live blocks updated.');
  await expect.poll(() => app.text()).toContain('2100');

  await app.press('ControlOrMeta+Home');
  await app.press('ArrowDown');
  await card.getByRole('button', { name: 'Open Source' }).click();
  await expect(page).toHaveTitle(/Meals\.csv/, { timeout: 10_000 });
});

test('Stop Updating turns a live block into ordinary content, and Undo brings it back', async ({ app, page }) => {
  await importVault(app, page, [
    { name: 'Meals.csv', data: 'Day,Calories\nMon,2100\n' },
    { name: 'Plan.md', data: 'This week:\n\n![[Meals.csv]]\n\nThat is all.\n' },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Plan.md' }).click();
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('2100');

  const card = page.getByRole('dialog', { name: 'Live Block' });
  await app.focus();
  await app.press('ControlOrMeta+Home');
  await app.press('ArrowDown');
  await card.getByRole('button', { name: 'Stop Updating' }).click();
  await expect(card).toBeHidden();
  // The table stays, and can now be typed in; the file has no markers.
  await app.focus();
  await app.press('ControlOrMeta+Home');
  await app.press('ArrowDown');
  await app.type('Z');
  await expect.poll(() => app.text()).toContain('ZDay');
  let file = await app.download(() => app.menu('File', 'Download'));
  expect(file.text).not.toContain('golem:live');
  expect(file.text).toContain('| Mon | 2100 |');

  // Undo takes back the typing, then Stop Updating: the block is live again.
  await app.press('ControlOrMeta+Z');
  await expect.poll(() => app.text()).not.toContain('ZDay');
  await app.press('ControlOrMeta+Z');
  await expect.poll(async () => (await app.download(() => app.menu('File', 'Download'))).text).toContain('<!-- golem:live Meals.csv');
  await app.focus();
  await app.press('ControlOrMeta+Home');
  await app.press('ArrowDown');
  await expect(card).toBeVisible();
  file = await app.download(() => app.menu('File', 'Download'));
  expect(file.text).toContain('<!-- /golem:live -->');
});

test('a block whose source is gone keeps its last result, and its card says why', async ({ app, page }) => {
  await importVault(app, page, [{ name: 'Plan.md', data: 'This week:\n\n<!-- golem:live Meals.csv stamp=00000000 -->\n\n| Day | Calories |\n| --- | ---: |\n| Mon | 2100 |\n\n<!-- /golem:live -->\n\nThat is all.\n' }]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Plan.md' }).click();
  await expect.poll(() => status(page), { timeout: 20_000 }).toContain('Meals.csv isn’t in the vault.');
  expect(await app.text()).toContain('2100');
  await app.focus();
  await app.press('ControlOrMeta+Home');
  await app.press('ArrowDown');
  const card = page.getByRole('dialog', { name: 'Live Block' });
  await expect(card.getByRole('alert')).toHaveText('Meals.csv isn’t in the vault.');
});


test('a block someone else made keeps what it came with until it is made one’s own', async ({ app, page }) => {
  // Signed by a secret this browser doesn't hold (docs/live-blocks.md §1, *Who a block belongs to*).
  const theirs = 'deadbeef0123456789abcdef';
  await importVault(app, page, [
    { name: 'Meals.csv', data: 'Day,Calories\nMon,2100\nTue,1900\n' },
    { name: 'Form.md', data: `Please fill in:\n\n<!-- golem:live Meals.csv by=${theirs} stamp=00000000 -->\n\n| Day | Calories |\n| --- | ---: |\n| Mon | sent |\n\n<!-- /golem:live -->\n\nThanks.\n` },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Form.md' }).click();

  // Asked once; until then nothing is read from this vault.
  const asked = page.getByRole('dialog', { name: 'Live Blocks Made by Someone Else' });
  await expect(asked).toBeVisible({ timeout: 20_000 });
  await expect(asked).toContainText('Meals.csv');
  await page.keyboard.press('Escape');
  await expect(asked).toBeHidden();
  expect(await app.text()).toContain('sent');
  expect(await app.text()).not.toContain('1900');

  // The block's card offers Make It Mine in place of Update Now.
  await app.focus();
  await app.press('ControlOrMeta+Home');
  await app.press('ArrowDown');
  const card = page.getByRole('dialog', { name: 'Live Block' });
  await expect(card.getByRole('alert')).toContainText('Made by someone else');
  await expect(card.getByRole('button', { name: 'Update Now' })).toBeHidden();
  await card.getByRole('button', { name: 'Make It Mine' }).click();
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('1900');

  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.text).toMatch(/<!-- golem:live Meals\.csv by=[0-9a-f]{24} stamp=[0-9a-f]{8} -->/);
  expect(file.text).not.toContain(theirs);
});

const REPORT = '---\nstatus: draft\n---\n\n# Intro\n\nHello.\n\n# Costs\n\nWe pay rent.\n\n# Later\n\nEnd.\n';

test('a note shows a section and a front matter field of another note', async ({ app, page }) => {
  await importVault(app, page, [
    { name: 'Report.md', data: REPORT },
    { name: 'Plan.md', data: 'Status: ![[Report.md#field:status]].\n\n<!-- golem:live Report.md#Costs stamp=00000000 -->\n\nold\n\n<!-- /golem:live -->\n\nEnd of plan.\n' },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Plan.md' }).click();
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('We pay rent.');
  const text = await app.text();
  expect(text).toContain('Status: draft.');
  expect(text).not.toContain('old');
  expect(text).not.toContain('Hello.');
});

test('Copy as Live Link copies the section at the caret, and pasting it shows that section', async ({ app, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await importVault(app, page, [
    { name: 'Report.md', data: REPORT },
    { name: 'Plan.md', data: 'The plan.\n' },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Report.md' }).click();
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('We pay rent.');
  await app.focus();
  await app.press('ControlOrMeta+Home');
  for (let i = 0; i < 3; i++) await app.press('ArrowDown');
  await app.menu('Edit', 'Copy as Live Link');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('![[Report.md#Costs]]');

  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open Plan.md' }).click();
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('The plan.');
  await app.focus();
  await app.press('ControlOrMeta+End');
  await app.press('Enter');
  await app.press('ControlOrMeta+V');
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('We pay rent.');
});

test('Copy as Live Link in a spreadsheet copies the selection’s address', async ({ app, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await importVault(app, page, [{ name: 'Meals.csv', data: 'Day,Calories\nMon,2100\nTue,1900\n' }]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Meals.csv' }).click();
  await expect(page).toHaveTitle(/Meals\.csv/, { timeout: 20_000 });
  await app.menu('Edit', 'Copy as Live Link');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 }).toMatch(/^!\[\[Meals\.csv#.+\]\]$/);
});

const chartsBook = () => readFileSync(resolve(process.cwd(), 'client/test/fixtures/sheets/charts.xlsx'));

test('a note shows a workbook’s chart as a picture', async ({ app, page }) => {
  await importVault(app, page, [
    { name: 'charts.xlsx', data: chartsBook() },
    { name: 'Plan.md', data: 'Sales:\n\n![[charts.xlsx#chart:Sales by month]]\n\nThat is all.\n' },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Plan.md' }).click();
  // Filled in on opening: the downloaded note has the chart's picture between the block's markers.
  const filled = /<!-- golem:live charts\.xlsx#chart:Sales by month by=[0-9a-f]{24} stamp=[0-9a-f]{8} -->\n\n!\[[^\]]*\]\([^)]+\)/;
  await expect.poll(async () => (await app.download(() => app.menu('File', 'Download'))).text, { timeout: 20_000 }).toMatch(filled);
});

test('a note shows a page of a PDF as a picture', async ({ app, page }) => {
  const contract = makePdf({ pages: [[{ text: 'Cover', x: 40, y: 240, size: 18 }], [{ text: 'Signed by both', x: 40, y: 240, size: 18 }]], extraContent: '1 0 0 rg 40 40 120 30 re f' });
  await importVault(app, page, [
    { name: 'Contract.pdf', data: contract },
    { name: 'Deal.md', data: 'The signed page:\n\n![[Contract.pdf#page:2]]\n' },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Deal.md' }).click();
  const filled = /<!-- golem:live Contract\.pdf#page:2 by=[0-9a-f]{24} stamp=[0-9a-f]{8} -->\n\n!\[[^\]]*\]\([^)]+\)/;
  await expect.poll(async () => (await app.download(() => app.menu('File', 'Download'))).text, { timeout: 20_000 }).toMatch(filled);
});

test('Copy as Live Link with a chart picked copies the chart', async ({ app, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await app.goto('?doc=welcome');
  await dropFile(page, { name: 'charts.xlsx', buffer: chartsBook(), mimeType: 'application/octet-stream' });
  await waitForOpen(app, 'charts.xlsx');
  await expect.poll(() => page.evaluate(() => (window as unknown as { sheetEditor: { state(): { charts: unknown[] } } }).sheetEditor.state().charts.length)).toBe(7);
  await app.menu('Insert', 'Chart', 'Line');
  await expect.poll(() => page.evaluate(() => (window as unknown as { sheetEditor: { state(): { chart: number | null } } }).sheetEditor.state().chart)).toBe(7);
  await app.menu('Edit', 'Copy as Live Link');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 }).toMatch(/^!\[\[charts\.xlsx#chart:.+\]\]$/);
});

/** A workbook with one sheet, Plan, holding "Meals" in A1. */
async function planBook(): Promise<Buffer> {
  const { Workbook } = await import('../../client/src/sheet/model/workbook.ts');
  const { Worksheet } = await import('../../client/src/sheet/model/worksheet.ts');
  const { Kind } = await import('../../client/src/sheet/model/column.ts');
  const { writeWorkbook } = await import('../../client/src/sheet/xlsx/write.ts');
  const book = new Workbook();
  const sheet = new Worksheet('Plan', 1);
  book.sheets.push(sheet);
  sheet.grid.set(0, 0, Kind.String, book.strings.add('Meals'), 0);
  return Buffer.from(await writeWorkbook(book, { recalculate: false }));
}

type SheetLook = { content: { display: string } | null; loaded: boolean } | null;
const sheetState = (page: Page) => page.evaluate(() => (window as unknown as { sheetEditor: { state(): SheetLook } }).sheetEditor.state());

async function clickCell(page: Page, row: number, col: number): Promise<void> {
  const pointOf = () => page.evaluate(([r, c]) => (window as unknown as { sheetEditor: { pointOf(r: number, c: number): { x: number; y: number } | null } }).sheetEditor.pointOf(r, c), [row, col] as const);
  // Just after loading the cells may not be laid out yet.
  await expect.poll(pointOf, { timeout: 5_000 }).not.toBeNull();
  const at = await pointOf();
  if (!at) throw new Error('no such cell on screen');
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(box.x + at.x, box.y + at.y);
}

test('a live link pasted into a spreadsheet fills a range from its source, and the range cannot be typed in', async ({ app, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await importVault(app, page, [
    { name: 'Meals.csv', data: 'Day,Calories\nMon,2100\nTue,1900\n' },
    { name: 'Plan.xlsx', data: await planBook() },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Plan.xlsx' }).click();
  await expect.poll(async () => (await sheetState(page))?.loaded, { timeout: 20_000 }).toBe(true);
  await clickCell(page, 2, 1);
  await page.evaluate(() => navigator.clipboard.writeText('![[Meals.csv]]'));
  await page.keyboard.press('ControlOrMeta+V');
  // Filled at once: Mon's calories are in C4.
  await expect
    .poll(
      async () => {
        await clickCell(page, 3, 2).catch(() => undefined);
        return (await sheetState(page))?.content?.display;
      },
      { timeout: 20_000 },
    )
    .toBe('2100');
  await page.keyboard.type('5');
  await page.keyboard.press('Enter');
  await expect.poll(() => status(page)).toContain('Meals.csv');
  // The cell still holds what the source gave (the selection settles after the refused edit's Enter).
  await expect
    .poll(async () => {
      await clickCell(page, 3, 2).catch(() => undefined);
      return (await sheetState(page))?.content?.display;
    })
    .toBe('2100');

  // Stop Updating, from the cell's menu: the cells are ordinary ones again, and can be typed in.
  await page.keyboard.press('Escape');
  const at = await page.evaluate(() => (window as unknown as { sheetEditor: { pointOf(r: number, c: number): { x: number; y: number } | null } }).sheetEditor.pointOf(3, 2));
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(box.x + at!.x, box.y + at!.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Stop Updating' }).click();
  await page.keyboard.type('5');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => {
      await clickCell(page, 3, 2).catch(() => undefined);
      return (await sheetState(page))?.content?.display;
    })
    .toBe('5');
});

test('a live link pasted into a PDF form field fills it from its source, and the downloaded PDF holds the value', async ({ app, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const form = makePdf({ pages: [[{ text: 'Tax return', x: 40, y: 270, size: 16 }]], fields: [{ kind: 'text', name: 'Total', rect: [40, 220, 240, 240] }] });
  await importVault(app, page, [
    { name: 'Total.csv', data: '3140\n' },
    { name: 'Return.pdf', data: form },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Return.pdf' }).click();
  const total = page.locator('.wm-field[aria-label="Total"], .wm-field-live');
  await expect(total).toBeVisible({ timeout: 20_000 });
  await total.click();
  await page.evaluate(() => navigator.clipboard.writeText('![[Total.csv]]'));
  await page.keyboard.press('ControlOrMeta+V');
  // Filled from the CSV, and read-only from then on.
  const live = page.locator('.wm-field-live');
  await expect(live).toHaveValue('3140', { timeout: 20_000 });
  await expect(live).toHaveJSProperty('readOnly', true);
  await expect(live).toHaveAttribute('title', /Total\.csv/);
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(decodePdf(file.bytes)).toMatch(/\/V\s*\(3140\)/);
});

test('a live link pasted into a PDF makes a text box, or a picture, filled from its source and written into the downloaded PDF', async ({ app, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const logo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEklEQVR4AQEHAPj/AAAA/wD/AAYBAf8F5AonAAAAAElFTkSuQmCC', 'base64');
  await importVault(app, page, [
    { name: 'Total.csv', data: '3140\n' },
    { name: 'Logo.png', data: logo },
    { name: 'Letter.pdf', data: makePdf({ pages: [[{ text: 'Dear reader', x: 40, y: 270, size: 16 }]] }) },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Letter.pdf' }).click();
  await waitForOpen(app, 'Letter.pdf');
  await app.focus();
  await page.evaluate(() => navigator.clipboard.writeText('![[Total.csv]]'));
  await page.keyboard.press('ControlOrMeta+V');
  await expect.poll(async () => decodePdf((await app.download(() => app.menu('File', 'Download'))).bytes), { timeout: 20_000 }).toMatch(/\(3140\)/);
  await app.focus();
  await page.evaluate(() => navigator.clipboard.writeText('![[Logo.png]]'));
  await page.keyboard.press('ControlOrMeta+V');
  // The picture is the logo's 2 × 1 pixels, not the empty one it starts as.
  await expect.poll(async () => decodePdf((await app.download(() => app.menu('File', 'Download'))).bytes), { timeout: 20_000 }).toMatch(/\/Subtype\s*\/Image[^>]*\/Width\s+2\b|\/Width\s+2\b[^>]*\/Subtype\s*\/Image/);
});

test('Copy as Live Link in a PDF form field copies the field’s address', async ({ app, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const form = makePdf({ pages: [[{ text: 'Tax return', x: 40, y: 270, size: 16 }]], fields: [{ kind: 'text', name: 'Total', rect: [40, 220, 240, 240] }] });
  await importVault(app, page, [{ name: 'Return.pdf', data: form }]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Return.pdf' }).click();
  const total = page.locator('.wm-field[aria-label="Total"]');
  await expect(total).toBeVisible({ timeout: 20_000 });
  await total.fill('1250');
  await app.menu('Edit', 'Copy as Live Link');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('![[Return.pdf#field:Total]]');
});

test('Copy as Live Link in a PDF, outside a form field, copies the page in view', async ({ app, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await importVault(app, page, [{ name: 'Contract.pdf', data: makePdf({ pages: [[{ text: 'Cover', x: 40, y: 240, size: 18 }]] }) }]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Contract.pdf' }).click();
  await waitForOpen(app, 'Contract.pdf');
  await app.menu('Edit', 'Copy as Live Link');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 }).toBe('![[Contract.pdf#page:1]]');
});

test('Insert › Live Block lists a folder’s notes with a front matter column', async ({ app, page }) => {
  await importVault(app, page, [
    { name: 'Characters/Ann.md', data: '---\nrole: captain\n---\nAnn leads.\n' },
    { name: 'Characters/Bo.md', data: '---\nrole: cook\n---\nBo cooks.\n' },
    { name: 'Cast.md', data: '# Cast\n\nWho is who:\n' },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Cast.md' }).click();
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('Who is who');
  await app.focus();
  await app.press('ControlOrMeta+End');
  await app.menu('Insert', 'Live Block…');
  const dialog = page.getByRole('dialog', { name: 'Insert Live Block' });
  await dialog.getByRole('button', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'Vault/Characters' }).click();
  await dialog.getByRole('textbox', { name: 'Columns:' }).fill('role');
  await expect(dialog.locator('.wm-live-address')).toHaveText('![[@list:Vault/Characters?columns=role]]');
  await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('captain');
  expect(await app.text()).toContain('cook');
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.text).toMatch(/<!-- golem:live @list:Vault\/Characters\?columns=role by=[0-9a-f]{24} stamp=[0-9a-f]{8} -->\n\n\| Characters \| role \|\n\| --- \| --- \|\n\| Ann \| captain \|\n\| Bo \| cook \|/);
});

test('Insert › Live Block counts a folder’s words against a goal, in the line', async ({ app, page }) => {
  await importVault(app, page, [
    { name: 'Novel/One.md', data: 'It was a dark and stormy night.\n' },
    { name: 'Novel/Two.md', data: 'The end.\n' },
    { name: 'Progress.md', data: 'Words so far:\n' },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Progress.md' }).click();
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('Words so far');
  await app.focus();
  await app.press('ControlOrMeta+End');
  await app.type(' ');
  await app.menu('Insert', 'Live Block…');
  const dialog = page.getByRole('dialog', { name: 'Insert Live Block' });
  await dialog.getByRole('button', { name: 'Count', exact: true }).click();
  await dialog.getByRole('button', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'Vault/Novel' }).click();
  await dialog.getByRole('spinbutton', { name: 'Goal' }).fill('50000');
  await expect(dialog.locator('.wm-live-address')).toHaveText('![[@count:Vault/Novel?goal=50000]]');
  await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('Words so far: 9 / 50,000');
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.text).toMatch(/Words so far: <!-- golem:live @count:Vault\/Novel\?goal=50000 by=[0-9a-f]{24} stamp=/);
});

test('Insert › Live Block shows a CSV’s rows that meet a condition, sorted', async ({ app, page }) => {
  await importVault(app, page, [
    { name: 'Meals.csv', data: 'Day,Meal,Calories\nMon,Soup,1900\nTue,Pasta,2400\nThu,Pizza,2600\n' },
    { name: 'Plan.md', data: 'Big days:\n' },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Plan.md' }).click();
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('Big days');
  await app.focus();
  await app.press('ControlOrMeta+End');
  await app.menu('Insert', 'Live Block…');
  const dialog = page.getByRole('dialog', { name: 'Insert Live Block' });
  await dialog.getByRole('button', { name: 'Table', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Columns:' }).fill('Day, Calories');
  await dialog.getByRole('textbox', { name: 'Sort by:' }).fill('Calories');
  await dialog.getByRole('checkbox', { name: 'Reverse order' }).check();
  await expect(dialog.locator('.wm-live-address')).toHaveText('![[Meals.csv?sort=-Calories&columns=Day, Calories]]');
  await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('Thu');
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.text).toMatch(/\| Day \| Calories \|\n\| --- \| ---: \|\n\| Thu \| 2600 \|\n\| Tue \| 2400 \|\n\| Mon \| 1900 \|/);
  expect(file.text).not.toContain('Pasta');
});

test('a live link pasted into a drawing shows its source as a group, kept in the downloaded SVG', async ({ app, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect id="box" x="20" y="20" width="120" height="80" fill="#e53935"/></svg>';
  await importVault(app, page, [
    { name: 'Total.csv', data: '3140\n' },
    { name: 'Plan.svg', data: svg },
  ]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Plan.svg' }).click();
  const layers = page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');
  await expect(layers).toHaveCount(1, { timeout: 30_000 });
  await page.evaluate(() => navigator.clipboard.writeText('![[Total.csv]]'));
  await page.keyboard.press('ControlOrMeta+V');
  await expect(layers.filter({ hasText: 'Group' })).toHaveCount(1, { timeout: 20_000 });
  // Filled from the CSV: the downloaded file has the group, its source and the value.
  await expect
    .poll(async () => (await app.download(() => app.menu('File', 'Download'))).text, { timeout: 20_000 })
    .toMatch(/data-golem-live="Total\.csv"[^>]*>[\s\S]*3140/);

  // Stop Updating, from the group's menu in the layers: the group keeps what it shows, with no source.
  await layers.filter({ hasText: 'Group' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Stop Updating' }).click();
  await expect
    .poll(async () => (await app.download(() => app.menu('File', 'Download'))).text)
    .not.toContain('data-golem-live');
  expect((await app.download(() => app.menu('File', 'Download'))).text).toContain('3140');
});

test('File › Live PDF Copy saves a PDF beside the document, written again when the document changes', async ({ app, page }) => {
  await importVault(app, page, [{ name: 'Report.md', data: '# Report\n\nOne page for now.\n' }]);
  await app.menu('File', 'Open…');
  await dashboard(page).getByRole('button', { name: 'Open folder Vault' }).click();
  await dashboard(page).getByRole('button', { name: 'Open Report.md' }).click();
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('One page for now.');
  await app.menu('File', 'Live PDF Copy');
  await expect.poll(() => status(page), { timeout: 20_000 }).toContain('Made Report.pdf');
  // File › Open shows the folder it last showed.
  const openInVault = async (name: string): Promise<void> => {
    await app.menu('File', 'Open…');
    const file = dashboard(page).getByRole('button', { name: `Open ${name}` });
    const folder = dashboard(page).getByRole('button', { name: 'Open folder Vault' });
    await expect(file.or(folder).first()).toBeVisible();
    if (await folder.isVisible()) await folder.click();
    await file.click();
  };
  const pages = async (): Promise<number> => {
    await openInVault('Report.pdf');
    await expect(page).toHaveTitle(/Report\.pdf/, { timeout: 20_000 });
    const file = await app.download(() => app.menu('File', 'Download'));
    return decodePdf(file.bytes).match(/\/Type\s*\/Page\b/g)?.length ?? 0;
  };
  expect(await pages()).toBe(1);
  // The report grows to a second page; leaving it brings its PDF up to date.
  await openInVault('Report.md');
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('One page for now.');
  await app.focus();
  await app.press('ControlOrMeta+End');
  await app.press('Enter', 70);
  await app.type('The end.');
  await expect.poll(pages, { timeout: 60_000, intervals: [2_000] }).toBeGreaterThan(1);
});
