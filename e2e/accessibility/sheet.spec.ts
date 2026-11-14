// Screen Reader Mode in the spreadsheet editor (docs/architecture/accessibility.md, "Spreadsheets"): moving the active cell,
// selecting, switching sheets and picking a chart are announced; F6 reaches the formula bar, the cells and the sheet tabs;
// the filter card gives the keyboard back; the cells follow Windows' contrast themes.

import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MOD, expect, test, type App } from '../fixtures';
import { dropFile, waitForOpen } from '../files/helpers';
import { pngPixels } from '../layout/helpers';

interface SheetState {
  loaded: boolean;
  sheet: number;
  active: { row: number; col: number };
  chart: number | null;
  charts: string[][];
  editing: unknown;
}

const state = (page: Page): Promise<SheetState> => page.evaluate(() => (window as unknown as { sheetEditor: { state(): SheetState } }).sheetEditor.state());

async function openWorkbook(app: App, name: string, file: string): Promise<void> {
  await app.goto('?doc=welcome');
  await dropFile(app.page, { name, buffer: readFileSync(resolve(process.cwd(), `client/test/fixtures/sheets/${file}`)), mimeType: 'application/octet-stream' });
  await waitForOpen(app, name);
  await expect.poll(async () => (await state(app.page)).loaded, { timeout: 20_000 }).toBe(true);
}

/** What the polite live region says now. */
const said = (app: App) => app.page.locator('.wm-sr-only[aria-live="polite"]');

async function screenReaderOn(app: App): Promise<void> {
  await app.menu('Tools', 'Screen Reader Mode');
  await expect(app.page.locator('.wm-sr-only[aria-live]', { hasText: 'Screen Reader Mode on' })).toHaveCount(1);
}

const cells = (app: App) => app.page.locator('.wm-sheet-input');

test.describe('Spreadsheets in Screen Reader Mode', () => {
  test('moving the active cell says its address, value and formula; a range and another sheet are said too', async ({ app }) => {
    await openWorkbook(app, 'lookup.xlsx', 'oracle/lookup.xlsx');
    await screenReaderOn(app);
    // Turned on: where the selection is.
    await expect(said(app)).toHaveText('Cases, sheet 1 of 2. A1, formula');
    await cells(app).focus();
    await app.press('ArrowDown');
    await app.press('ArrowRight');
    await expect(said(app)).toHaveText(/^B2, 10, formula =VLOOKUP\("apple",Data!C1:D5,2,FALSE\)$/);
    await app.press('Shift+ArrowDown', 2);
    await expect(said(app)).toHaveText('B2 to B4 selected');
    await app.press('Tab');
    await expect(said(app)).toHaveText(/^B3, 10, formula =VLOOKUP\("APPLE"/);
    // Go To from the name box, onto the other sheet.
    const nameBox = app.page.getByRole('textbox', { name: 'Name box' });
    await nameBox.fill('Data!A1');
    await nameBox.press('Enter');
    await expect(said(app)).toHaveText(/^Data, sheet 2 of 2\. A1, /);
    // Editing a cell: the editor is named by the cell and holds its text, so typing and the caret are read as they are.
    await app.press('F2');
    const editor = app.page.locator('.wm-sheet-editor');
    await expect(editor).toBeFocused();
    await expect(editor).toHaveAttribute('aria-label', 'Editing A1');
    await app.press('Escape');
    await expect(cells(app)).toBeFocused();
  });

  test('without it nothing is said, and the cells tell how to turn it on', async ({ app }) => {
    await openWorkbook(app, 'lookup.xlsx', 'oracle/lookup.xlsx');
    await expect(cells(app)).toHaveAttribute('aria-description', /Screen Reader Mode/);
    await cells(app).focus();
    await app.press('ArrowDown');
    await expect.poll(async () => (await state(app.page)).active).toEqual({ row: 1, col: 0 });
    await app.settle();
    await expect(app.page.locator('.wm-sr-only[aria-live]', { hasText: 'A2' })).toHaveCount(0);
  });

  test('F6 goes to the sheet tabs and the formula bar; the arrow keys on the tabs switch sheets', async ({ app }) => {
    await openWorkbook(app, 'lookup.xlsx', 'oracle/lookup.xlsx');
    await screenReaderOn(app);
    await cells(app).focus();
    await app.press('F6');
    const cases = app.page.getByRole('tab', { name: 'Cases' });
    await expect(cases).toBeFocused();
    await expect(app.page.getByRole('tablist', { name: 'Sheets' })).toBeVisible();
    await app.press('ArrowRight');
    await expect.poll(async () => (await state(app.page)).sheet).toBe(1);
    await expect(app.page.getByRole('tab', { name: 'Data' })).toBeFocused();
    await expect(said(app)).toHaveText(/^Data, sheet 2 of 2\. /);
    await app.press('Escape');
    await expect(cells(app)).toBeFocused();
    await app.press('Shift+F6');
    await expect(app.page.getByRole('textbox', { name: 'Name box' })).toBeFocused();
    await app.press('F6');
    await expect(cells(app)).toBeFocused();
  });

  test('a chart is picked from the keyboard and said by its kind and title', async ({ app }) => {
    await openWorkbook(app, 'charts.xlsx', 'charts.xlsx');
    await expect.poll(async () => (await state(app.page)).charts.length).toBe(7);
    await screenReaderOn(app);
    await cells(app).focus();
    await app.press(`${MOD}+Alt+5`);
    await expect.poll(async () => (await state(app.page)).chart).toBe(0);
    await expect(said(app)).toHaveText('Column chart: Sales by month, 1 of 7');
    await app.press('Tab');
    await expect.poll(async () => (await state(app.page)).chart).toBe(1);
    await expect(said(app)).toHaveText('Bar chart: Stacked, 2 of 7');
    await app.press('Shift+Tab');
    await expect(said(app)).toHaveText('Column chart: Sales by month, 1 of 7');
    // Its menu from the keyboard, then back to the cells.
    await app.press('Shift+F10');
    await expect(app.page.getByRole('menuitem', { name: 'Select Data' })).toBeVisible();
    await app.press('Escape');
    await expect(cells(app)).toBeFocused();
    await app.press('Escape');
    await expect.poll(async () => (await state(app.page)).chart).toBe(null);
    await expect(said(app)).toHaveText(/^A1, /);
  });

  test('Alt+Down on a filter’s header opens its card, and Escape gives the keyboard back to the cells', async ({ app }) => {
    await openWorkbook(app, 'lookup.xlsx', 'oracle/lookup.xlsx');
    await screenReaderOn(app);
    await cells(app).focus();
    await app.menu('Sheet', 'Filter');
    await expect.poll(async () => ((await state(app.page)) as unknown as { filter: { range: { r0: number } } | null }).filter?.range.r0).toBe(0);
    await cells(app).focus();
    await app.press('ArrowRight');
    await expect(said(app)).toHaveText(/^B1, .*filter, Alt\+Down to filter/);
    await app.press('Alt+ArrowDown');
    const card = app.page.getByRole('dialog', { name: 'Filter' });
    await expect(card).toBeVisible();
    await expect(card.getByRole('checkbox', { name: '(Select All)' })).toBeFocused();
    await expect(card.getByRole('group', { name: 'Values to show' })).toBeVisible();
    await app.press('Escape');
    await expect(card).toBeHidden();
    await expect(cells(app)).toBeFocused();
  });

  test('the cells are drawn in the contrast theme’s colours', async ({ app }) => {
    await app.page.emulateMedia({ forcedColors: 'none', colorScheme: 'light' });
    await openWorkbook(app, 'lookup.xlsx', 'oracle/lookup.xlsx');
    const darkShare = async () => {
      const { data } = pngPixels(await app.canvas.screenshot());
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 128) dark++;
      return dark / (data.length / 4);
    };
    expect(await darkShare()).toBeLessThan(0.3);
    await app.page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' });
    await expect.poll(darkShare).toBeGreaterThan(0.6);
  });
});
