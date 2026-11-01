// The spreadsheet editor (docs/spreadsheets.md): a workbook opens in it, cells are typed into, rows are inserted, sheets are added,
// and the workbook downloads as .xlsx with the changes; opening it again from this browser maps its memory image. The cells are
// drawn on the canvas, so the specs read the editor through `window.sheetEditor` (see main.ts) and click where it says cells are.

import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MOD, expect, test } from '../files/fixtures';
import { dropFile, readZip, waitForOpen } from '../files/helpers';

interface SheetState {
  fromImage: boolean;
  loaded: boolean;
  sheet: number;
  active: { row: number; col: number };
  editing: unknown;
  content: { input: string; display: string; isFormula: boolean; look?: { bold: boolean } };
  info: { name: string; rows: number; cols: number } | null;
  sheets: string[];
  canUndo: boolean;
  canRedo: boolean;
}

const state = (page: Page): Promise<SheetState> => page.evaluate(() => (window as unknown as { sheetEditor: { state(): SheetState } }).sheetEditor.state());

const workbook = () => ({ name: 'lookup.xlsx', buffer: readFileSync(resolve(process.cwd(), 'client/test/fixtures/sheets/oracle/lookup.xlsx')), mimeType: 'application/octet-stream' });

async function open(app: Parameters<typeof waitForOpen>[0], page: Page): Promise<void> {
  await app.goto('?doc=welcome');
  await dropFile(page, workbook());
  await waitForOpen(app, 'lookup.xlsx');
  await expect.poll(async () => (await state(page)).loaded, { timeout: 20_000 }).toBe(true);
}

/** Clicks the middle of a cell. */
async function clickCell(page: Page, row: number, col: number): Promise<void> {
  const at = await page.evaluate(([r, c]) => (window as unknown as { sheetEditor: { pointOf(r: number, c: number): { x: number; y: number } | null } }).sheetEditor.pointOf(r, c), [row, col] as const);
  if (!at) throw new Error('no such cell on screen');
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(box.x + at.x, box.y + at.y);
}

test('a workbook opens in the spreadsheet editor, with its sheets', async ({ app, page }) => {
  await open(app, page);
  const s = await state(page);
  expect(s.sheets).toEqual(['Cases', 'Data']);
  expect(s.info?.name).toBe('Cases');
  await expect(page.getByRole('tab', { name: 'Data' })).toBeVisible();
  await expect(page.getByRole('menubar').getByRole('menuitem', { name: 'Sheet' })).toBeVisible();
  // The formula bar shows the active cell's contents.
  await expect(page.getByRole('textbox', { name: 'Formula bar' })).toHaveValue('formula');
});

test('typing into a cell keeps the value, Enter moves down, and undo takes it back', async ({ app, page }) => {
  await open(app, page);
  await clickCell(page, 1, 4);
  await expect.poll(async () => (await state(page)).active).toEqual({ row: 1, col: 4 });
  await page.keyboard.type('12.5%');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).active).toEqual({ row: 2, col: 4 });
  // Back up with the arrow key (a second click this soon at the same spot would be a double click, which edits the cell).
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await state(page)).content).toMatchObject({ input: '12.5%', display: '12.50%', isFormula: false });
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await state(page)).content.input).toBe('');
});

test('a formula cell shows its formula in the formula bar', async ({ app, page }) => {
  await open(app, page);
  await clickCell(page, 1, 1);
  await expect.poll(async () => (await state(page)).content).toMatchObject({ input: '=VLOOKUP("apple",Data!C1:D5,2,FALSE)', display: '10', isFormula: true });
});

test('a formula typed calculates, spills, and recalculates when what it reads changes', async ({ app, page }) => {
  await open(app, page);
  await clickCell(page, 1, 5);
  await page.keyboard.type('4');
  await page.keyboard.press('Enter');
  await page.keyboard.type('=F2*10');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await state(page)).content).toMatchObject({ input: '=F2*10', display: '40', isFormula: true });
  // A dynamic array fills the cells below it.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('=SEQUENCE(3)');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).content.display).toBe('2');
  // Changing F2 changes F3.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('7');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).content).toMatchObject({ input: '=F2*10', display: '70', isFormula: true });
});

test('cells are formatted with the app’s formatting commands and the Sheet menu', async ({ app, page }) => {
  await open(app, page);
  await clickCell(page, 1, 5);
  await page.keyboard.type('0.25');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press(`${MOD}+b`);
  await expect.poll(async () => (await state(page)).content.look?.bold).toBe(true);
  await app.menu('Sheet', 'Number Format', 'Percentage');
  await expect.poll(async () => (await state(page)).content.display).toBe('25.00%');
  await app.menu('Sheet', 'Decrease Decimal');
  await expect.poll(async () => (await state(page)).content.display).toBe('25.0%');
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await state(page)).content.display).toBe('25.00%');
  // The Sheet toolbar does the same: more decimals, then currency.
  await page.getByRole('button', { name: 'Increase Decimal' }).click();
  await expect.poll(async () => (await state(page)).content.display).toBe('25.000%');
  await page.getByRole('button', { name: 'Currency' }).click();
  await expect.poll(async () => (await state(page)).content.display).toBe('$0.25');
});

test('double-clicking a column header’s edge fits the column to its text', async ({ app, page }) => {
  await open(app, page);
  await clickCell(page, 1, 5);
  await page.keyboard.type('a much longer piece of text than fits');
  await page.keyboard.press('Enter');
  const edge = () => page.evaluate(() => (window as unknown as { sheetEditor: { columnEdge(c: number): { x: number; y: number; width: number } } }).sheetEditor.columnEdge(5));
  const before = await edge();
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.dblclick(box.x + before.x, box.y + before.y);
  await expect.poll(async () => (await edge()).width).toBeGreaterThan(before.width * 2);
});

test('Sort and Replace from the menus', async ({ app, page }) => {
  await open(app, page);
  // Column C of the Data sheet holds fruit names; sort them, then replace one.
  await page.getByRole('tab', { name: 'Data' }).click();
  await expect.poll(async () => (await state(page)).info?.name).toBe('Data');
  await clickCell(page, 0, 2);
  await app.menu('Sheet', 'Sort Z to A');
  await expect.poll(async () => (await state(page)).content.input).toBe('date');
  await app.menu('Edit', 'Replace');
  await page.getByRole('textbox', { name: 'Find in workbook' }).fill('date');
  await page.getByRole('textbox', { name: 'Replace with' }).fill('fig');
  await page.getByRole('button', { name: 'Replace all' }).click();
  await expect.poll(async () => (await state(page)).content.input).toBe('fig');
});

test('dragging the fill handle carries a series on', async ({ app, page }) => {
  await open(app, page);
  await clickCell(page, 1, 5);
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  const point = (r: number, c: number) => page.evaluate(([row, col]) => (window as unknown as { sheetEditor: { pointOf(r: number, c: number): { x: number; y: number } } }).sheetEditor.pointOf(row, col), [r, c] as const);
  const box = (await page.locator('#canvas').boundingBox())!;
  // The handle is at the corner of F3, halfway to the middle of G4.
  const [f3, g4, f6] = [await point(2, 5), await point(3, 6), await point(5, 5)];
  await page.mouse.move(box.x + (f3.x + g4.x) / 2, box.y + (f3.y + g4.y) / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + f6.x, box.y + f6.y, { steps: 5 });
  await page.mouse.up();
  await clickCell(page, 5, 5);
  await expect.poll(async () => (await state(page)).content.input).toBe('5');
});

test('Sheet › Filter puts buttons on the header row, and its card hides the rows not ticked', async ({ app, page }) => {
  await open(app, page);
  await clickCell(page, 0, 0);
  await app.menu('Sheet', 'Filter');
  await expect.poll(async () => ((await state(page)) as unknown as { filter: { range: { r0: number } } | null }).filter?.range.r0).toBe(0);
  // The button sits at the right of the header cell: click a little left of the cell's right edge.
  const at = await page.evaluate(() => {
    const s = (window as unknown as { sheetEditor: { columnEdge(c: number): { x: number }; pointOf(r: number, c: number): { y: number } } }).sheetEditor;
    return { x: s.columnEdge(0).x - 8, y: s.pointOf(0, 0).y };
  });
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(box.x + at.x, box.y + at.y);
  const card = page.getByRole('dialog', { name: 'Filter' });
  await expect(card).toBeVisible();
  await card.getByRole('checkbox', { name: '(Select All)' }).uncheck();
  await card.getByRole('checkbox', { name: '=VLOOKUP("apple",Data!C1:D5,2,FALSE)', exact: true }).check();
  await card.getByRole('button', { name: 'OK' }).click();
  await expect.poll(async () => ((await state(page)) as unknown as { hiddenRows: number }).hiddenRows).toBeGreaterThan(10);
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => ((await state(page)) as unknown as { hiddenRows: number }).hiddenRows).toBe(0);
});

test('Sheet › Group groups rows; the outline’s box collapses them and its level buttons show them again', async ({ app, page }) => {
  await open(app, page);
  const outline = async () => (await state(page)) as unknown as { hiddenRows: number; outline: { rows: [number, number, boolean][] } | null };
  await clickCell(page, 1, 0);
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await app.menu('Sheet', 'Group', 'Group Rows');
  await expect.poll(async () => (await outline()).outline?.rows.map(([row, level]) => [row, level])).toEqual([[1, 1], [2, 1], [3, 1]]);
  // The group's box is in the gutter left of the row headers, at the row after the group.
  const box = (await page.locator('#canvas').boundingBox())!;
  const rowY = (r: number) => page.evaluate((row) => (window as unknown as { sheetEditor: { pointOf(r: number, c: number): { y: number } } }).sheetEditor.pointOf(row, 0).y, r);
  const headers = (await rowY(0)) - 20;
  await page.mouse.click(box.x + 6, box.y + (await rowY(4)));
  await expect.poll(async () => (await outline()).hiddenRows).toBe(3);
  // The level buttons, beside the column headers: 2 shows every row again; 1 hides the group's.
  await page.mouse.click(box.x + 20, box.y + headers);
  await expect.poll(async () => (await outline()).hiddenRows).toBe(0);
  await page.mouse.click(box.x + 6, box.y + headers);
  await expect.poll(async () => (await outline()).hiddenRows).toBe(3);
  await app.menu('Sheet', 'Group', 'Ungroup Rows');
  await expect.poll(async () => (await outline()).outline).toBe(null);
});

test('a table made with Insert Table has filter buttons of its own, and a formula typed in a new column fills it', async ({ app, page }) => {
  await open(app, page);
  // C1:C27 is empty beside the A:B block: a header there makes it part of the table.
  await clickCell(page, 0, 2);
  await page.keyboard.type('Twice');
  await page.keyboard.press('Enter');
  await clickCell(page, 0, 0);
  await app.menu('Sheet', 'Insert Table');
  await expect.poll(async () => ((await state(page)) as unknown as { tableFilters: { table: string }[] | null }).tableFilters?.map((f) => f.table)).toEqual(['Table1']);
  await clickCell(page, 3, 2);
  await page.keyboard.type('=LEN(A4)');
  await page.keyboard.press('Enter');
  await clickCell(page, 20, 2);
  await expect.poll(async () => (await state(page)).content.input).toBe('=LEN(A21)');
  // The button on the table's first header cell; tick one value only.
  const at = await page.evaluate(() => {
    const s = (window as unknown as { sheetEditor: { columnEdge(c: number): { x: number }; pointOf(r: number, c: number): { y: number } } }).sheetEditor;
    return { x: s.columnEdge(1).x - 8, y: s.pointOf(0, 1).y };
  });
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(box.x + at.x, box.y + at.y);
  const card = page.getByRole('dialog', { name: 'Filter' });
  await expect(card).toBeVisible();
  await card.getByRole('checkbox', { name: '(Select All)' }).uncheck();
  await card.getByRole('checkbox', { name: 'five', exact: true }).check();
  await card.getByRole('button', { name: 'OK' }).click();
  await expect.poll(async () => ((await state(page)) as unknown as { hiddenRows: number }).hiddenRows).toBe(24);
});

test('a workbook’s charts are drawn over its cells, and follow their data', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, { name: 'charts.xlsx', buffer: readFileSync(resolve(process.cwd(), 'client/test/fixtures/sheets/charts.xlsx')), mimeType: 'application/octet-stream' });
  await waitForOpen(app, 'charts.xlsx');
  const charts = async () => ((await state(page)) as unknown as { charts: string[][] }).charts;
  await expect.poll(async () => (await charts()).map((c) => c[0])).toEqual(['Sales by month', 'Stacked', 'Trend', 'North', 'South', 'Area', 'North against South']);
  // A value far past the others stretches the first chart's axis.
  await clickCell(page, 1, 1);
  await page.keyboard.type('90');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await charts())[0]).toContain('100');
  // Select Data, from the chart's menu: the West series taken away.
  const first = ((await state(page)) as unknown as { chartBoxes: number[][] }).chartBoxes[0];
  const middle = await page.evaluate(([x, y]) => (window as unknown as { sheetEditor: { screenOf(x: number, y: number): { x: number; y: number } } }).sheetEditor.screenOf(x, y), [first[0] + first[2] / 2, first[1] + first[3] / 2] as const);
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(box.x + middle.x, box.y + middle.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Select Data' }).click();
  const dialog = page.getByRole('dialog', { name: 'Select Data' });
  await expect(dialog.getByRole('textbox', { name: 'Values' }).first()).toHaveValue('=Sales!$B$2:$B$7');
  await dialog.getByRole('button', { name: 'Remove Series' }).nth(2).click();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect.poll(async () => (await charts())[0]).not.toContain('West');
  expect((await charts())[0]).toContain('South');
});

test('Sheet › PivotTable › Refresh lays a pivot table out again from its changed source', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, { name: 'pivots.xlsx', buffer: readFileSync(resolve(process.cwd(), 'client/test/fixtures/sheets/pivots-excel.xlsx')), mimeType: 'application/octet-stream' });
  await waitForOpen(app, 'pivots.xlsx');
  await expect.poll(async () => (await state(page)).loaded).toBe(true);
  // A sale of glue in the South, in place of the first one.
  await clickCell(page, 1, 0);
  await page.keyboard.type('South');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Glue');
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'Pivot' }).click();
  await expect.poll(async () => (await state(page)).info?.name).toBe('Pivot');
  await app.menu('Sheet', 'PivotTable', 'Refresh');
  await clickCell(page, 7, 0);
  await expect.poll(async () => (await state(page)).content.input).toBe('South');
  await clickCell(page, 3, 4);
  await expect.poll(async () => (await state(page)).content.input).toBe('Glue');
});

test('Insert › PivotTable makes a pivot on a new sheet from the field list; its menu changes its fields', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, { name: 'pivots.xlsx', buffer: readFileSync(resolve(process.cwd(), 'client/test/fixtures/sheets/pivots-excel.xlsx')), mimeType: 'application/octet-stream' });
  await waitForOpen(app, 'pivots.xlsx');
  await expect.poll(async () => (await state(page)).loaded).toBe(true);
  await clickCell(page, 0, 0);
  await app.menu('Insert', 'PivotTable');
  const dialog = page.getByRole('dialog', { name: 'PivotTable Fields' });
  const area = (field: number, to: string) => async () => {
    await dialog.getByRole('button', { name: 'Area' }).nth(field).click();
    await page.getByRole('option', { name: to, exact: true }).click();
  };
  await area(0, 'Rows')();
  await area(3, 'Values')();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect.poll(async () => (await state(page)).info?.name).toBe('Sheet3');
  await clickCell(page, 3, 0);
  await expect.poll(async () => (await state(page)).content.input).toBe('East');
  await clickCell(page, 6, 1);
  await expect.poll(async () => (await state(page)).content.input).toBe('1055');
  // Its menu: products across.
  const box = (await page.locator('#canvas').boundingBox())!;
  const at = await page.evaluate(() => (window as unknown as { sheetEditor: { pointOf(r: number, c: number): { x: number; y: number } } }).sheetEditor.pointOf(3, 0));
  await page.mouse.click(box.x + at.x, box.y + at.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'PivotTable Fields' }).click();
  await area(1, 'Columns')();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await clickCell(page, 3, 1);
  await expect.poll(async () => (await state(page)).content.input).toBe('Pens');
});

test('sparklines are drawn in their cells and follow their data', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, { name: 'sparklines.xlsx', buffer: readFileSync(resolve(process.cwd(), 'client/test/fixtures/sheets/sparklines-excel.xlsx')), mimeType: 'application/octet-stream' });
  await waitForOpen(app, 'sparklines.xlsx');
  const drawn = async () => ((await state(page)) as unknown as { sparklines: number }).sparklines;
  await expect.poll(drawn).toBeGreaterThan(0);
  const before = await drawn();
  await clickCell(page, 1, 3);
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  await expect.poll(drawn).not.toBe(before);
  // Insert › Sparklines › Clear Sparklines on the first row's three, then a column sparkline of its values in H2.
  const withThree = await drawn();
  await clickCell(page, 1, 7);
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await app.menu('Insert', 'Sparklines', 'Clear Sparklines');
  await expect.poll(drawn).toBeLessThan(withThree);
  const cleared = await drawn();
  await clickCell(page, 1, 1);
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
  await app.menu('Insert', 'Sparklines', 'Column');
  await expect.poll(drawn).toBeGreaterThan(cleared);
});

test('Insert › Chart makes a chart beside the data; it is picked, changed from its menu, dragged and deleted', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, { name: 'charts.xlsx', buffer: readFileSync(resolve(process.cwd(), 'client/test/fixtures/sheets/charts.xlsx')), mimeType: 'application/octet-stream' });
  await waitForOpen(app, 'charts.xlsx');
  const look = async () => (await state(page)) as unknown as { charts: string[][]; chart: number | null };
  await expect.poll(async () => (await look()).charts.length).toBe(7);
  await clickCell(page, 0, 0);
  await app.menu('Insert', 'Chart', 'Line');
  await expect.poll(async () => (await look()).charts.length).toBe(8);
  await expect.poll(async () => (await look()).chart).toBe(7);
  // Its menu turns it into a pie (the first series' months).
  const box = (await page.locator('#canvas').boundingBox())!;
  const middle = await page.evaluate(() => {
    const s = (window as unknown as { sheetEditor: { pointOf(r: number, c: number): { x: number; y: number } } }).sheetEditor;
    return s.pointOf(8, 8);
  });
  await page.mouse.click(box.x + middle.x, box.y + middle.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Chart Type' }).click();
  await page.getByRole('menuitem', { name: 'Pie' }).click();
  await expect.poll(async () => (await look()).charts[7]).toContain('Jan');
  // Dragged down, then deleted.
  await page.mouse.move(box.x + middle.x, box.y + middle.y);
  await page.mouse.down();
  await page.mouse.move(box.x + middle.x + 40, box.y + middle.y + 120, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await look()).chart).toBe(7);
  // Its bottom right handle, dragged out, makes it bigger.
  const boxes = async () => ((await state(page)) as unknown as { chartBoxes: number[][] }).chartBoxes;
  await expect.poll(async () => (await boxes())[7][1]).toBeGreaterThan(30);
  const [x0, y0, w0, h0] = (await boxes())[7];
  const toScreen = await page.evaluate(([x, y]) => (window as unknown as { sheetEditor: { screenOf(x: number, y: number): { x: number; y: number } } }).sheetEditor.screenOf(x, y), [x0 + w0, y0 + h0] as const);
  await page.mouse.move(box.x + toScreen.x, box.y + toScreen.y);
  await page.mouse.down();
  await page.mouse.move(box.x + toScreen.x + 80, box.y + toScreen.y + 60, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await boxes())[7][2]).toBeGreaterThan(w0 + 40);
  expect((await boxes())[7][3]).toBeGreaterThan(h0 + 30);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await look()).charts.length).toBe(7);
});

test('a list validation offers its choices from an arrow, and a value a rule refuses is not entered', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, { name: 'validation.xlsx', buffer: readFileSync(resolve(process.cwd(), 'client/test/fixtures/sheets/validation.xlsx')), mimeType: 'application/octet-stream' });
  await waitForOpen(app, 'validation.xlsx');
  await expect.poll(async () => (await state(page)).loaded, { timeout: 20_000 }).toBe(true);
  await clickCell(page, 1, 1);
  await expect.poll(async () => (await state(page)).content.input).toBe('Open');
  // The arrow sits just right of the cell, at its bottom.
  const at = await page.evaluate(() => {
    const s = (window as unknown as { sheetEditor: { columnEdge(c: number): { x: number }; pointOf(r: number, c: number): { y: number } } }).sheetEditor;
    return { x: s.columnEdge(1).x + 8, y: s.pointOf(1, 1).y + 3 };
  });
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(box.x + at.x, box.y + at.y);
  await page.getByRole('menuitem', { name: 'Blocked' }).click();
  await expect.poll(async () => (await state(page)).content.input).toBe('Blocked');
  // A score must be a whole number from 1 to 10: 11 is refused with the rule's message, and the cell keeps its value.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('11');
  await page.keyboard.press('Enter');
  await expect(page.getByText('A score is a whole number from 1 to 10.')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await state(page)).content.input).toBe('3');
});

test('resting the pointer on a cell with a note shows the note', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, { name: 'notes.xlsx', buffer: readFileSync(resolve(process.cwd(), 'client/test/fixtures/sheets/notes.xlsx')), mimeType: 'application/octet-stream' });
  await waitForOpen(app, 'notes.xlsx');
  await expect.poll(async () => (await state(page)).loaded, { timeout: 20_000 }).toBe(true);
  const at = await page.evaluate(() => (window as unknown as { sheetEditor: { pointOf(r: number, c: number): { x: number; y: number } } }).sheetEditor.pointOf(1, 1));
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.move(box.x + at.x, box.y + at.y);
  await expect(page.getByRole('note')).toContainText('Price before tax');
  // Leaving the cell hides it.
  await page.mouse.move(box.x + at.x, box.y + at.y + 60);
  await expect(page.getByRole('note')).toBeHidden();
});

test('Sheet › New Note types a note into a card beside the cell; Delete Note takes it away', async ({ app, page }) => {
  await open(app, page);
  await clickCell(page, 2, 1);
  await app.menu('Sheet', 'New Note');
  const card = page.getByRole('dialog', { name: 'New Note' });
  await expect(card.getByRole('textbox', { name: 'Note' })).toBeFocused();
  await page.keyboard.type('Looked up');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('in Data');
  await page.keyboard.press('Enter');
  await expect(card).toBeHidden();
  // The pointer resting on the cell shows it; New Note again opens it with its text, to change.
  const at = await page.evaluate(() => (window as unknown as { sheetEditor: { pointOf(r: number, c: number): { x: number; y: number } } }).sheetEditor.pointOf(2, 1));
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.move(box.x + at.x, box.y + at.y);
  await expect(page.getByRole('note')).toContainText('Looked up\nin Data');
  await page.mouse.move(box.x + at.x, box.y + at.y + 80);
  await clickCell(page, 2, 1);
  await app.menu('Sheet', 'New Note');
  await expect(card.getByRole('textbox', { name: 'Note' })).toHaveValue('Looked up\nin Data');
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await app.menu('Sheet', 'Delete Note');
  await page.mouse.move(box.x + at.x, box.y + at.y);
  await page.waitForTimeout(600);
  await expect(page.getByRole('note')).toBeHidden();
  // The note goes in the file too.
  await page.keyboard.press(`${MOD}+z`);
  const file = await app.download(() => app.menu('File', 'Download'));
  const comments = readZip(file.bytes).find((p) => p.name.startsWith('xl/comments'));
  expect(comments?.bytes.toString('utf8')).toContain('Looked up');
});

test('Protect Sheet with a password keeps locked cells from being typed into until Unprotect Sheet', async ({ app, page }) => {
  await open(app, page);
  await clickCell(page, 1, 5);
  await app.menu('Sheet', 'Protection', 'Unlock Cells');
  await app.menu('Sheet', 'Protection', 'Protect Sheet');
  const dialog = page.getByRole('dialog', { name: 'Protect Sheet' });
  await dialog.getByRole('textbox', { name: 'Password', exact: true }).fill('pw');
  await dialog.getByRole('textbox', { name: 'Password again' }).fill('pw');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  const protection = async () => (await state(page)) as unknown as { protection: { password: boolean } | null; locked: boolean };
  await expect.poll(async () => (await protection()).protection).toEqual({ password: true });
  // A locked cell says no; the unlocked one takes what is typed.
  await clickCell(page, 1, 4);
  await expect.poll(async () => (await protection()).locked).toBe(true);
  await page.keyboard.type('7');
  await expect(page.getByText('This sheet is protected.').first()).toBeVisible();
  await clickCell(page, 1, 5);
  await page.keyboard.type('8');
  await page.keyboard.press('Enter');
  await clickCell(page, 1, 5);
  await expect.poll(async () => (await state(page)).content.input).toBe('8');
  // Unprotecting asks for the password; a wrong one is turned away.
  await app.menu('Sheet', 'Protection', 'Unprotect Sheet');
  const unprotect = page.getByRole('dialog', { name: 'Unprotect Sheet' });
  await unprotect.getByRole('textbox', { name: 'Password' }).fill('nope');
  await unprotect.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByText('That password isn’t right.').first()).toBeVisible();
  await app.menu('Sheet', 'Protection', 'Unprotect Sheet');
  await unprotect.getByRole('textbox', { name: 'Password' }).fill('pw');
  await unprotect.getByRole('button', { name: 'OK' }).click();
  await clickCell(page, 1, 4);
  await page.keyboard.type('7');
  await page.keyboard.press('Enter');
  await clickCell(page, 1, 4);
  await expect.poll(async () => (await state(page)).content.input).toBe('7');
});

test('copying and pasting cells in a workbook moves their formulas; Paste Values pastes only values', async ({ app, page }) => {
  await open(app, page);
  await clickCell(page, 1, 5);
  await page.keyboard.type('4');
  await page.keyboard.press('Tab');
  await page.keyboard.type('=F2*10');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await state(page)).active).toEqual({ row: 1, col: 6 });
  await page.keyboard.press(`${MOD}+c`);
  await clickCell(page, 4, 6);
  await page.keyboard.press(`${MOD}+v`);
  await expect.poll(async () => (await state(page)).content).toMatchObject({ input: '=F5*10', isFormula: true });
  await clickCell(page, 6, 6);
  await app.menu('Sheet', 'Paste Special', 'Paste Values');
  await expect.poll(async () => (await state(page)).content).toMatchObject({ input: '40', isFormula: false });
});

test('rows inserted from the Sheet menu move the cells below', async ({ app, page }) => {
  await open(app, page);
  await clickCell(page, 2, 0);
  await app.menu('Sheet', 'Insert Rows Above');
  await clickCell(page, 3, 0);
  // The case that was in row 3 (its text in column A) is in row 4 now.
  await expect.poll(async () => (await state(page)).content.input).toBe('=VLOOKUP("APPLE",Data!C1:D5,2,FALSE)');
});

test('a new sheet comes from the + button, and tabs switch sheets', async ({ app, page }) => {
  await open(app, page);
  await page.getByRole('button', { name: 'New Sheet' }).click();
  await expect.poll(async () => (await state(page)).sheets).toEqual(['Cases', 'Sheet3', 'Data']);
  await expect.poll(async () => (await state(page)).info?.name).toBe('Sheet3');
  await page.getByRole('tab', { name: 'Data' }).click();
  await expect.poll(async () => (await state(page)).info?.name).toBe('Data');
});

test('the workbook downloads as .xlsx with what was typed', async ({ app, page }) => {
  await open(app, page);
  await clickCell(page, 1, 5);
  await page.keyboard.type('typed here');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).canUndo).toBe(true);
  const file = await app.download(() => app.menu('File', 'Download'));
  expect(file.name).toBe('lookup.xlsx');
  const parts = readZip(file.bytes);
  const sheet = parts.find((p) => p.name === 'xl/worksheets/sheet1.xml');
  expect(sheet?.bytes.toString('utf8')).toContain('typed here');
  expect(parts.some((p) => p.name === 'xl/worksheets/sheet2.xml')).toBe(true);
});

test('opening it again from this browser maps its memory image', async ({ app, page }) => {
  await open(app, page);
  // The image of the file just read is kept with the saved copy; reopening the page opens that copy.
  await page.waitForTimeout(1500);
  await page.reload();
  await app.ready();
  await expect.poll(async () => (await state(page))?.info?.name, { timeout: 20_000 }).toBe('Cases');
  expect((await state(page)).fromImage).toBe(true);
});
