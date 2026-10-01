// Merging and splitting table cells (src/tableModel.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphsIn, paragraphText, type Paragraph, type Table, type TableCell, type TableRow } from '@golemdocs/docx';
import { mergeCells, splitCell } from '../src/tableModel.ts';

let counter = 0x100;
const fresh = () => (counter++).toString(16).toUpperCase().padStart(8, '0');
const para = (text: string): Paragraph => ({ kind: 'paragraph', properties: {}, children: text ? [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text }] }] : [], attrs: { 'w14:paraId': fresh() } });
const cell = (text: string, extra: Partial<TableCell['properties']> = {}): TableCell => ({ kind: 'cell', properties: { width: { w: '2000', type: 'dxa' }, ...extra }, children: [para(text)], attrs: {} });
const row = (...cells: TableCell[]): TableRow => ({ kind: 'row', properties: {}, cells, attrs: {} });
/** A table of `rows` given as arrays of texts, every cell one column wide, 2000 twips each. */
const grid = (rows: string[][]): Table => ({ kind: 'table', properties: {}, grid: new Array<number>(rows[0].length).fill(2000), rows: rows.map((r) => row(...r.map((t) => cell(t)))) });

/** The table as text: each cell as its text, ×n for a span over n columns, ↓ for the top of a vertical merge, ^ for a cell under it. */
const shape = (table: Table): string[][] =>
  table.rows.map((r) =>
    (r.kind === 'row' ? r.cells : []).map((c) => {
      if (c.kind !== 'cell') return '?';
      const p = c.properties;
      return paragraphsIn(c.children).map(paragraphText).join('/') + (p.gridSpan && p.gridSpan > 1 ? `×${p.gridSpan}` : '') + (p.vMerge === 'restart' ? '↓' : p.vMerge === 'continue' ? '^' : '');
    }),
  );
const widths = (table: Table) => table.rows.map((r) => (r.kind === 'row' ? r.cells.map((c) => (c.kind === 'cell' ? Number(c.properties.width?.w) : 0)) : []));

test('merging cells side by side makes one cell spanning them, with all their text', () => {
  const t = grid([['a', 'b', 'c'], ['d', 'e', 'f']]);
  const merged = mergeCells(t, { first: 0, last: 0, from: 0, to: 2 }, fresh)!;
  assert.deepEqual(shape(merged.table), [['a/b×2', 'c'], ['d', 'e', 'f']]);
  assert.deepEqual(widths(merged.table)[0], [4000, 2000], 'the merged cell is as wide as the two');
  assert.equal(paragraphText(merged.caret), 'a');
  assert.equal(shape(t)[0].length, 3, 'the original table is untouched');
});

test('merging over rows and columns, and cells that are empty add no blank lines', () => {
  const t = grid([['a', '', 'c'], ['', 'e', 'f'], ['g', 'h', 'i']]);
  const merged = mergeCells(t, { first: 0, last: 1, from: 0, to: 2 }, fresh)!;
  assert.deepEqual(shape(merged.table), [['a/e×2↓', 'c'], ['×2^', 'f'], ['g', 'h', 'i']]);
  // A rectangle that cuts through a merged cell grows to hold it (here down and across to "g" and "h").
  const again = mergeCells(merged.table, { first: 1, last: 2, from: 1, to: 2 }, fresh)!;
  assert.deepEqual(shape(again.table), [['a/e/g/h×2↓', 'c'], ['×2^', 'f'], ['×2^', 'i']]);
  // Nothing to merge in one cell, or outside the table.
  assert.equal(mergeCells(t, { first: 0, last: 0, from: 0, to: 1 }, fresh), null);
  assert.equal(mergeCells(t, { first: 0, last: 5, from: 0, to: 1 }, fresh), null);
});

test('merging keeps every paragraph (and its id) exactly once', () => {
  const t = grid([['a', 'b'], ['c', 'd']]);
  const before = paragraphsIn([t]).map((p) => p.attrs['w14:paraId']);
  const { table } = mergeCells(t, { first: 0, last: 1, from: 0, to: 2 }, fresh)!;
  const after = paragraphsIn([table]).map((p) => p.attrs['w14:paraId']);
  assert.equal(new Set(after).size, after.length, 'no id twice');
  for (const id of before) assert.ok(after.includes(id), 'every paragraph with text keeps its id');
  assert.deepEqual(shape(table), [['a/b/c/d×2↓'], ['×2^']]);
});

test('splitting a merged cell goes back along its merges', () => {
  const t = grid([['a', 'b', 'c'], ['d', 'e', 'f']]);
  const merged = mergeCells(t, { first: 0, last: 1, from: 0, to: 2 }, fresh)!.table;
  // Into two columns: still one cell tall over two rows, the text in the first.
  assert.deepEqual(shape(splitCell(merged, 0, 0, 2, 1, fresh)!.table), [['a/b/d/e↓', '↓', 'c'], ['^', '^', 'f']]);
  // Into two rows: each row has its own cell again, still two columns wide.
  assert.deepEqual(shape(splitCell(merged, 0, 0, 1, 2, fresh)!.table), [['a/b/d/e×2', 'c'], ['×2', 'f']]);
  // Both: four separate cells, no merges left.
  assert.deepEqual(shape(splitCell(merged, 0, 0, 2, 2, fresh)!.table), [['a/b/d/e', '', 'c'], ['', '', 'f']]);
  // More than it was made of isn't possible for a merged cell: asking for five columns gives the two it had.
  assert.deepEqual(shape(splitCell(merged, 0, 0, 5, 1, fresh)!.table), [['a/b/d/e↓', '↓', 'c'], ['^', '^', 'f']]);
});

test('splitting a plain cell into columns adds grid columns and widens what is above and below', () => {
  const t = grid([['a', 'b'], ['c', 'd'], ['e', 'f']]);
  const { table, caret } = splitCell(t, 1, 0, 3, 1, fresh)!;
  assert.deepEqual(table.grid, [667, 667, 666, 2000], 'the column is shared out among the three');
  assert.deepEqual(shape(table), [['a×3', 'b'], ['c', '', '', 'd'], ['e×3', 'f']]);
  assert.equal(paragraphText(caret), 'c');
  assert.deepEqual(widths(table)[0], [2000, 2000], 'widths of spanning cells still add up');
});

test('splitting a plain cell into rows adds rows and runs the others down through them', () => {
  const t = grid([['a', 'b', 'c'], ['d', 'e', 'f']]);
  const { table } = splitCell(t, 0, 1, 1, 3, fresh)!;
  assert.equal(table.rows.length, 4);
  assert.deepEqual(shape(table), [['a↓', 'b', 'c↓'], ['^', '', '^'], ['^', '', '^'], ['d', 'e', 'f']]);
  const both = splitCell(t, 1, 0, 2, 2, fresh)!;
  assert.equal(both.table.rows.length, 3);
  assert.equal(both.table.grid.length, 4);
});

test('a table it cannot read safely is left alone', () => {
  const t = grid([['a', 'b']]);
  t.grid = [];
  assert.equal(mergeCells(t, { first: 0, last: 0, from: 0, to: 2 }, fresh), null, 'no grid');
  const ragged = grid([['a', 'b'], ['c', 'd']]);
  (ragged.rows[1] as TableRow).cells.pop();
  assert.equal(mergeCells(ragged, { first: 0, last: 0, from: 0, to: 2 }, fresh), null, 'a short row');
  assert.equal(splitCell(grid([['a']]), 0, 0, 1, 1, fresh), null, 'a split into one');
});
