// Laying a line of a big text file out on a grid of cells (src/textEditor/lines.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellAt, cellWidth, forEachCell, indexAtCell, layoutLine, rowCount, rowOf } from '../src/textEditor/lines.ts';

test('characters take one cell, wide ones two, combining marks none', () => {
  assert.equal(cellWidth('a'.codePointAt(0)!), 1);
  assert.equal(cellWidth('é'.codePointAt(0)!), 1);
  assert.equal(cellWidth('日'.codePointAt(0)!), 2);
  assert.equal(cellWidth('Ａ'.codePointAt(0)!), 2); // fullwidth
  assert.equal(cellWidth('한'.codePointAt(0)!), 2);
  assert.equal(cellWidth('😀'.codePointAt(0)!), 2);
  assert.equal(cellWidth(0x0301), 0); // combining acute
  assert.equal(cellWidth(0x200d), 0); // zero width joiner
  assert.equal(cellWidth(0xfe0f), 0); // variation selector
});

test('a short line is one row, an empty one too, and a long one breaks at the width', () => {
  assert.deepEqual(layoutLine('hello', 80), [{ from: 0, to: 5, cells: 5 }]);
  assert.deepEqual(layoutLine('', 80), [{ from: 0, to: 0, cells: 0 }]);
  assert.deepEqual(layoutLine('abcdefghij', 4), [
    { from: 0, to: 4, cells: 4 },
    { from: 4, to: 8, cells: 4 },
    { from: 8, to: 10, cells: 2 },
  ]);
  assert.equal(rowCount('x'.repeat(1000), 100), 10);
  assert.equal(rowCount('', 10), 1);
});

test('a line of exactly the width is one row', () => {
  assert.equal(layoutLine('abcd', 4).length, 1);
  assert.equal(layoutLine('abcde', 4).length, 2);
});

test('tabs run to the next multiple of 8 cells, from the start of each row', () => {
  const rows = layoutLine('a\tb', 80);
  assert.deepEqual(rows, [{ from: 0, to: 3, cells: 9 }]);
  assert.equal(cellAt('a\tb', rows[0], 2), 8);
  assert.equal(cellAt('a\tb', rows[0], 3), 9);
  // At the start of a row a tab is eight cells, even when the width is smaller than that.
  assert.deepEqual(layoutLine('\t\t', 5).map((r) => r.cells), [8, 8]);
});

test('a wide character is kept whole: it moves to the next row rather than split', () => {
  // 'abc' fills three of four cells; the two-cell character does not fit, so it starts the next row, with 'de' beside it.
  const rows = layoutLine('abc日def', 4);
  assert.deepEqual(rows.map((r) => [r.from, r.to, r.cells]), [[0, 3, 3], [3, 6, 4], [6, 7, 1]]);
});

test('an emoji is one character of two UTF-16 units and two cells', () => {
  const text = 'a😀b';
  const rows = layoutLine(text, 80);
  assert.equal(rows[0].cells, 4);
  assert.equal(cellAt(text, rows[0], 1), 1);
  assert.equal(cellAt(text, rows[0], 3), 3);
  const seen: number[][] = [];
  forEachCell(text, rows[0], (index, cp, cell, width) => seen.push([index, cp, cell, width]));
  assert.deepEqual(seen, [[0, 97, 0, 1], [1, 0x1f600, 1, 2], [3, 98, 3, 1]]);
});

test('combining marks sit on the cell of the letter before them', () => {
  const text = 'éx';
  const row = layoutLine(text, 80)[0];
  assert.equal(row.cells, 2);
  assert.equal(cellAt(text, row, 2), 1); // after the accent: still one cell in
  assert.equal(cellAt(text, row, 3), 2);
});

test('a position in cells finds the nearest character boundary', () => {
  const row = layoutLine('abcdef', 80)[0];
  assert.equal(indexAtCell('abcdef', row, 0), 0);
  assert.equal(indexAtCell('abcdef', row, 2.4), 2);
  assert.equal(indexAtCell('abcdef', row, 2.6), 3);
  assert.equal(indexAtCell('abcdef', row, 99), 6);
  assert.equal(indexAtCell('abcdef', row, -3), 0);
  const wide = layoutLine('日本', 80)[0];
  assert.equal(indexAtCell('日本', wide, 0.9), 0);
  assert.equal(indexAtCell('日本', wide, 1.1), 1);
  assert.equal(indexAtCell('日本', wide, 3.1), 2);
});

test('cells and indices round trip on every boundary, for plain and mixed text', () => {
  for (const text of ['hello world', 'a\tb\tc', 'café 日本語 😀 ok', 'x'.repeat(50)]) {
    for (const columns of [7, 20, 80]) {
      const rows = layoutLine(text, columns);
      for (const row of rows) {
        const boundaries = new Set<number>([row.from, row.to]);
        forEachCell(text, row, (index) => boundaries.add(index));
        for (const index of boundaries) assert.equal(indexAtCell(text, row, cellAt(text, row, index)), index, `${text} / ${columns} / ${index}`);
      }
    }
  }
});

test('the row holding an index', () => {
  const rows = layoutLine('abcdefghij', 4);
  assert.deepEqual([0, 3, 4, 7, 8, 10].map((i) => rowOf(rows, i)), [0, 0, 1, 1, 2, 2]);
});

test('every column count lays text out so no row is wider than the width, except one wide thing', () => {
  const text = 'The quick 日本語 brown\tfox 😀 jumps';
  for (let columns = 3; columns < 40; columns++) {
    const rows = layoutLine(text, columns);
    assert.equal(rows[0].from, 0);
    assert.equal(rows.at(-1)!.to, text.length);
    for (let r = 1; r < rows.length; r++) assert.equal(rows[r].from, rows[r - 1].to);
    for (const row of rows) if (row.to - row.from > 2) assert.ok(row.cells <= Math.max(columns, 8), `${columns}: ${row.cells}`);
  }
});
