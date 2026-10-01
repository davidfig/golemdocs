import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GLYPH_COLUMNS, GLYPH_TABLE_WIDTH, glyphTableHeight, glyphTexel, padGlyphTable } from '../src/webgl/text/glyphTable.ts';
import { inWinAnsi, pdfChar } from '../src/formats/pdfExport.ts';

test('glyph texel addressing folds into a grid', () => {
  assert.deepEqual(glyphTexel(0), { x: 0, y: 0 });
  assert.deepEqual(glyphTexel(1), { x: 2, y: 0 });
  assert.deepEqual(glyphTexel(GLYPH_COLUMNS - 1), { x: GLYPH_TABLE_WIDTH - 2, y: 0 });
  assert.deepEqual(glyphTexel(GLYPH_COLUMNS), { x: 0, y: 1 });
  assert.deepEqual(glyphTexel(3199), { x: (3199 % 128) * 2, y: 24 });
});

test('every glyph gets a distinct texel pair inside the texture', () => {
  const n = 3300;
  const height = glyphTableHeight(n);
  const seen = new Set<number>();
  for (let g = 0; g < n; g++) {
    const { x, y } = glyphTexel(g);
    assert.ok(x + 1 < GLYPH_TABLE_WIDTH && y < height);
    for (const k of [y * GLYPH_TABLE_WIDTH + x, y * GLYPH_TABLE_WIDTH + x + 1]) {
      assert.ok(!seen.has(k));
      seen.add(k);
    }
  }
});

test('table height stays far under 2048 texels for large faces', () => {
  assert.equal(glyphTableHeight(0), 1);
  assert.equal(glyphTableHeight(128), 1);
  assert.equal(glyphTableHeight(129), 2);
  assert.ok(glyphTableHeight(3200) <= 25);
  assert.ok(glyphTableHeight(60000) <= 512);
});

test('padding fills the last row and keeps the data', () => {
  const table = new Float32Array(8 * 130).fill(1);
  const padded = padGlyphTable(table);
  assert.equal(padded.length, 2 * GLYPH_TABLE_WIDTH * 4);
  assert.equal(padded[8 * 130 - 1], 1);
  assert.equal(padded[8 * 130], 0);
  assert.equal(padGlyphTable(new Float32Array(GLYPH_TABLE_WIDTH * 4)).length, GLYPH_TABLE_WIDTH * 4);
});

test('PDF export writes characters the standard fonts lack as a visible ?', () => {
  assert.deepEqual(pdfChar(0x41), { text: 'A', lost: false });
  assert.deepEqual(pdfChar(0xe9), { text: 'é', lost: false });
  assert.deepEqual(pdfChar(0x2019), { text: '’', lost: false });
  assert.deepEqual(pdfChar(0x2192), { text: '->', lost: false });
  assert.deepEqual(pdfChar(0x65e5), { text: '?', lost: true });
  assert.deepEqual(pdfChar(0x3042), { text: '?', lost: true });
  assert.deepEqual(pdfChar(undefined), { text: '?', lost: true });
  assert.ok(!inWinAnsi(0x81));
});
