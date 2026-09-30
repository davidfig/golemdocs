import { expect, test } from '../fixtures';
import { caretOf, choose, dialog, docx, firstTable, fillCells, insertTable, isMenuItemEnabled, pageCount, screenPoint, tables } from './helpers';

test.describe('inserting tables', () => {
  test.beforeEach(async ({ app }) => {
    await app.blank();
  });

  test('the toolbar grid picker shows the size under the pointer and inserts that table', async ({ app }) => {
    await app.toolbarButton('Insert Table').click();
    const cells = app.page.locator('.wm-tablegrid .wm-tablecell');
    await expect(app.page.locator('.wm-tablegrid-caption')).toHaveText('Cancel');
    // The grid starts 5 wide: the 2nd row, 3rd cell is index 1 * 5 + 2.
    await cells.nth(1 * 5 + 2).hover();
    await expect(app.page.locator('.wm-tablegrid-caption')).toHaveText('2 × 3 Table');
    await cells.nth(1 * 5 + 2).click();
    await expect(app.page.locator('.wm-tablegrid-panel')).toHaveCount(0);
    await expect.poll(async () => (await firstTable(app)).map((r) => r.length)).toEqual([3, 3]);
    // The caret is in the first cell.
    await app.type('x');
    expect((await firstTable(app))[0][0]).toBe('x');
  });

  test('the grid grows as the pointer reaches its edge', async ({ app }) => {
    await app.toolbarButton('Insert Table').click();
    const before = await app.page.locator('.wm-tablegrid .wm-tablecell').count();
    await app.page.locator('.wm-tablegrid .wm-tablecell').last().hover();
    await expect.poll(() => app.page.locator('.wm-tablegrid .wm-tablecell').count()).toBeGreaterThan(before);
    await app.page.keyboard.press('Escape');
  });

  test('Insert ▸ Table… asks for columns and rows (5 × 2 to start with) and makes the table', async ({ app }) => {
    await app.menu('Insert', 'Table…');
    const dlg = dialog(app, 'Insert Table');
    await expect(dlg.getByRole('spinbutton', { name: 'Number of columns' })).toHaveValue('5');
    await expect(dlg.getByRole('spinbutton', { name: 'Number of rows' })).toHaveValue('2');
    await dlg.getByRole('spinbutton', { name: 'Number of columns' }).fill('2');
    await dlg.getByRole('spinbutton', { name: 'Number of rows' }).fill('4');
    await dlg.getByRole('button', { name: 'OK' }).click();
    await expect.poll(async () => (await firstTable(app)).map((r) => r.length)).toEqual([2, 2, 2, 2]);
  });

  test('Cancel and a size that is out of range insert nothing', async ({ app }) => {
    await app.menu('Insert', 'Table…');
    const dlg = dialog(app, 'Insert Table');
    await dlg.getByRole('spinbutton', { name: 'Number of rows' }).fill('9999');
    await dlg.getByRole('button', { name: 'OK' }).click();
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toHaveCount(0);
    expect(tables((await docx(app)).xml)).toHaveLength(0);
  });

  test('a table goes after the paragraph with the caret, and splits a paragraph the caret is in the middle of', async ({ app }) => {
    await app.type('headtail');
    await app.press('ArrowLeft', 4);
    await insertTable(app, 2, 1);
    await app.type('in');
    const { xml } = await docx(app);
    expect(xml.indexOf('head')).toBeLessThan(xml.indexOf('<w:tbl>'));
    expect(xml.indexOf('<w:tbl>')).toBeLessThan(xml.indexOf('tail'));
    expect((await firstTable(app))[0]).toEqual(['in', '']);
  });

  test('a table is inserted with one undo step and Undo takes it out', async ({ app }) => {
    await app.type('text');
    await insertTable(app, 2, 2);
    await expect.poll(async () => tables((await docx(app)).xml).length).toBe(1);
    await app.menu('Edit', 'Undo');
    await expect.poll(async () => tables((await docx(app)).xml).length).toBe(0);
    await expect.poll(() => app.text()).toBe('text');
  });
});

test.describe('the Table menu', () => {
  test.beforeEach(async ({ app }) => {
    await app.blank();
  });

  test('its commands are off outside a table and on inside one', async ({ app }) => {
    for (const path of [['Insert', 'Rows Above'], ['Insert', 'Rows Below'], ['Insert', 'Columns to the Left'], ['Insert', 'Columns to the Right'], ['Delete', 'Table'], ['Delete', 'Rows'], ['Delete', 'Columns'], ['Select Table'], ['Merge Cells'], ['Split Cells…']]) {
      expect(await isMenuItemEnabled(app, 'Table', ...path), path.join(' > ')).toBe(false);
    }
    expect(await isMenuItemEnabled(app, 'Table', 'Table…')).toBe(true);
    await insertTable(app, 2, 2);
    for (const path of [['Insert', 'Rows Above'], ['Insert', 'Columns to the Right'], ['Delete', 'Table'], ['Delete', 'Rows'], ['Delete', 'Columns'], ['Select Table'], ['Split Cells…']]) {
      expect(await isMenuItemEnabled(app, 'Table', ...path), path.join(' > ')).toBe(true);
    }
    expect(await isMenuItemEnabled(app, 'Table', 'Merge Cells')).toBe(true);
  });

  test('leaving the table by clicking above it turns the commands off again', async ({ app }) => {
    await app.type('above');
    await app.press('Enter');
    await insertTable(app, 2, 2);
    expect(await isMenuItemEnabled(app, 'Table', 'Delete', 'Rows')).toBe(true);
    await app.focus();
    await app.press('ControlOrMeta+Home');
    await expect.poll(async () => isMenuItemEnabled(app, 'Table', 'Delete', 'Rows')).toBe(false);
  });
});

test.describe('editing table structure', () => {
  test.beforeEach(async ({ app }) => {
    await app.blank();
    await insertTable(app, 3, 2);
    await fillCells(app, [
      ['a1', 'b1', 'c1'],
      ['a2', 'b2', 'c2'],
    ]);
  });

  /** Puts the caret in a cell by Tab/Shift+Tab from where it is: the caret is in the last cell, `back` cells from the end. */
  async function inCell(app: import('../fixtures').App, back: number): Promise<void> {
    for (let i = 0; i < back; i++) await app.press('Shift+Tab');
  }

  test('Insert Rows Below adds a row after the caret row, Above before it', async ({ app }) => {
    await inCell(app, 5); // a1
    await app.menu('Table', 'Insert', 'Rows Below');
    await expect.poll(async () => (await firstTable(app)).length).toBe(3);
    expect((await firstTable(app)).map((r) => r[0])).toEqual(['a1', '', 'a2']);
    await app.menu('Table', 'Insert', 'Rows Above');
    await expect.poll(async () => (await firstTable(app)).length).toBe(4);
    expect((await firstTable(app)).map((r) => r[0])).toEqual(['', 'a1', '', 'a2']);
  });

  test('Insert Columns Left and Right add a column beside the caret column', async ({ app }) => {
    await inCell(app, 4); // b1
    await app.menu('Table', 'Insert', 'Columns to the Right');
    await expect.poll(async () => (await firstTable(app))[0].length).toBe(4);
    expect(await firstTable(app)).toEqual([
      ['a1', 'b1', '', 'c1'],
      ['a2', 'b2', '', 'c2'],
    ]);
    await app.menu('Table', 'Insert', 'Columns to the Left');
    await expect.poll(async () => (await firstTable(app))[0].length).toBe(5);
    expect((await firstTable(app))[0]).toEqual(['a1', '', 'b1', '', 'c1']);
  });

  test('every insert is one undo step', async ({ app }) => {
    await inCell(app, 5);
    await app.menu('Table', 'Insert', 'Rows Below');
    await expect.poll(async () => (await firstTable(app)).length).toBe(3);
    await app.menu('Edit', 'Undo');
    await expect.poll(async () => (await firstTable(app)).length).toBe(2);
    await app.menu('Table', 'Insert', 'Columns to the Left');
    await expect.poll(async () => (await firstTable(app))[0].length).toBe(4);
    await app.menu('Edit', 'Undo');
    await expect.poll(async () => (await firstTable(app))[0].length).toBe(3);
    expect((await firstTable(app))[1]).toEqual(['a2', 'b2', 'c2']);
  });

  test('Delete Rows and Delete Columns remove the caret row and column', async ({ app }) => {
    await inCell(app, 4); // b1
    await app.menu('Table', 'Delete', 'Columns');
    await expect.poll(async () => (await firstTable(app))[0].length).toBe(2);
    expect(await firstTable(app)).toEqual([
      ['a1', 'c1'],
      ['a2', 'c2'],
    ]);
    await app.menu('Table', 'Delete', 'Rows');
    await expect.poll(async () => (await firstTable(app)).length).toBe(1);
    expect((await firstTable(app))[0].length).toBe(2);
    await app.menu('Edit', 'Undo');
    await expect.poll(async () => (await firstTable(app)).length).toBe(2);
  });

  test('deleting every row deletes the table, and so does Delete Table (undoable)', async ({ app }) => {
    await app.menu('Table', 'Delete', 'Rows');
    await expect.poll(async () => (await firstTable(app)).length).toBe(1);
    await app.menu('Table', 'Delete', 'Rows');
    await expect.poll(async () => tables((await docx(app)).xml).length).toBe(0);
    await app.menu('Edit', 'Undo');
    await app.menu('Edit', 'Undo');
    await expect.poll(async () => tables((await docx(app)).xml).length).toBe(1);
    await choose(app, 'Table', 'Delete', 'Table');
    await expect.poll(async () => tables((await docx(app)).xml).length).toBe(0);
    await app.menu('Edit', 'Undo');
    await expect.poll(async () => (await firstTable(app)).length).toBe(2);
    expect((await firstTable(app))[1]).toEqual(['a2', 'b2', 'c2']);
  });

  test('Select Table selects all of the table\'s text', async ({ app }) => {
    await app.menu('Table', 'Select Table');
    await expect.poll(() => app.selectedText()).toContain('a1');
    const text = await app.selectedText();
    for (const cell of ['a1', 'b1', 'c1', 'a2', 'b2', 'c2']) expect(text).toContain(cell);
  });
});

test.describe('typing and moving between cells', () => {
  test.beforeEach(async ({ app }) => {
    await app.blank();
    await insertTable(app, 2, 2);
  });

  test('typing goes in the cell, Enter adds a paragraph inside the cell', async ({ app }) => {
    await app.type('one');
    await app.press('Enter');
    await app.type('two');
    await expect.poll(async () => (await firstTable(app))[0][0]).toBe('one\ntwo');
    expect((await firstTable(app))[0][1]).toBe('');
  });

  test('Tab selects the next cell\'s text, so typing replaces it; Shift+Tab goes back', async ({ app }) => {
    await fillCells(app, [['a', 'b'], ['c', 'd']]);
    await app.press('Shift+Tab', 3); // back to "a"
    await expect.poll(() => app.selectedText()).toBe('a');
    await app.press('Tab');
    await expect.poll(() => app.selectedText()).toBe('b');
    await app.type('B');
    expect((await firstTable(app))[0]).toEqual(['a', 'B']);
    await app.press('Tab');
    await expect.poll(() => app.selectedText()).toBe('c');
  });

  test('Tab in the last cell adds a row and moves into it', async ({ app }) => {
    await fillCells(app, [['a', 'b'], ['c', 'd']]);
    expect((await firstTable(app)).length).toBe(2);
    await app.press('Tab');
    await expect.poll(async () => (await firstTable(app)).length).toBe(3);
    await app.type('e');
    await app.press('Tab');
    await app.type('f');
    expect(await firstTable(app)).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']]);
  });

  test('Tab outside a table types a tab character', async ({ app }) => {
    await choose(app, 'Table', 'Delete', 'Table');
    await expect.poll(async () => tables((await docx(app)).xml).length).toBe(0);
    await app.type('a');
    await app.press('Tab');
    await app.type('b');
    await expect.poll(() => app.text()).toBe('a\tb');
  });

  test('arrow keys move between cells and text typed there lands in the right one', async ({ app }) => {
    await fillCells(app, [['a', 'b'], ['c', 'd']]);
    await app.press('ArrowUp');
    await app.type('X');
    await expect.poll(async () => (await firstTable(app))[0].join('|')).toMatch(/X/);
    expect((await firstTable(app))[1]).toEqual(['c', 'd']);
  });

  test('a long table continues on a new page', async ({ app }) => {
    await choose(app, 'Table', 'Delete', 'Table');
    await insertTable(app, 2, 60);
    await expect.poll(() => pageCount(app.page)).toBeGreaterThanOrEqual(2);
    expect((await firstTable(app)).length).toBe(60);
  });
});

test.describe('merging and splitting cells', () => {
  test.beforeEach(async ({ app }) => {
    await app.blank();
    await insertTable(app, 3, 2);
    await fillCells(app, [
      ['a1', 'b1', 'c1'],
      ['a2', 'b2', 'c2'],
    ]);
    await app.press('ControlOrMeta+Home');
    await app.settle();
  });

  /** Drags across from the first cell's text to the second's, selecting cells a1:b1. */
  async function dragAcrossFirstRow(app: import('../fixtures').App): Promise<void> {
    await expect.poll(async () => (await caretOf(app.page))?.y).toBeGreaterThan(0);
    // Ctrl+Home puts the caret at the start of the document; the table's first cell is right there.
    const from = await screenPoint(app.page, 0, 76, (await caretOf(app.page))!.y + 6);
    const to = await screenPoint(app.page, 0, 76 + 156 + 20, (await caretOf(app.page))!.y + 6);
    await app.page.mouse.move(from.x, from.y);
    await app.page.mouse.down();
    await app.page.mouse.move((from.x + to.x) / 2, to.y, { steps: 4 });
    await app.page.mouse.move(to.x, to.y, { steps: 4 });
    await app.page.mouse.up();
  }

  test('dragging from one cell to the next selects the text of both', async ({ app }) => {
    await dragAcrossFirstRow(app);
    await expect.poll(() => app.selectedText()).toContain('b1');
    expect(await app.selectedText()).toContain('a1');
    expect(await app.selectedText()).not.toContain('c1');
    expect(await app.selectedText()).not.toContain('a2');
  });

  test('Merge Cells joins the selected cells, keeping their text, in one undo step', async ({ app }) => {
    await dragAcrossFirstRow(app);
    await expect.poll(() => app.selectedText()).toContain('b1');
    await app.menu('Table', 'Merge Cells');
    await expect.poll(async () => tables((await docx(app)).xml)[0][0].length).toBe(2);
    const [merged, rest] = tables((await docx(app)).xml)[0][0];
    expect(merged.span).toBe(2);
    expect(merged.text).toBe('a1\nb1');
    expect(rest.text).toBe('c1');
    expect(tables((await docx(app)).xml)[0][1]).toHaveLength(3);
    await app.menu('Edit', 'Undo');
    await expect.poll(async () => tables((await docx(app)).xml)[0][0].length).toBe(3);
  });

  test('Split Cells splits a merged cell back, asking how many columns and rows', async ({ app }) => {
    await dragAcrossFirstRow(app);
    await app.menu('Table', 'Merge Cells');
    await expect.poll(async () => tables((await docx(app)).xml)[0][0].length).toBe(2);
    await app.press('ControlOrMeta+Home');
    await app.menu('Table', 'Split Cells…');
    const dlg = dialog(app, 'Split Cells');
    await expect(dlg.getByRole('spinbutton', { name: 'Number of columns' })).toHaveValue('2');
    await expect(dlg.getByRole('spinbutton', { name: 'Number of rows' })).toHaveValue('1');
    await dlg.getByRole('button', { name: 'OK' }).click();
    await expect.poll(async () => tables((await docx(app)).xml)[0][0].length).toBe(3);
    expect(tables((await docx(app)).xml)[0][0].every((c) => c.span === 1)).toBe(true);
  });

  test('Split Cells on a plain cell makes room with more columns and rows; Cancel does nothing', async ({ app }) => {
    await app.menu('Table', 'Split Cells…');
    let dlg = dialog(app, 'Split Cells');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toHaveCount(0);
    expect(tables((await docx(app)).xml)[0].map((r) => r.length)).toEqual([3, 3]);
    await app.menu('Table', 'Split Cells…');
    dlg = dialog(app, 'Split Cells');
    await dlg.getByRole('spinbutton', { name: 'Number of columns' }).fill('2');
    await dlg.getByRole('spinbutton', { name: 'Number of rows' }).fill('2');
    await dlg.getByRole('button', { name: 'OK' }).click();
    await expect.poll(async () => tables((await docx(app)).xml)[0].length).toBeGreaterThanOrEqual(3);
    const rows = tables((await docx(app)).xml)[0];
    // The first cell's width is now shared by two columns: some row has a cell spanning more than one grid column or there are more cells.
    expect(rows.flat().length).toBeGreaterThan(6);
    await app.menu('Edit', 'Undo');
    await expect.poll(async () => tables((await docx(app)).xml)[0].map((r) => r.length)).toEqual([3, 3]);
  });
});
