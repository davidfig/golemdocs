import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHUNK_ROWS, Column, Grid, Kind, MAX_ROWS } from '../src/sheet/model/column.ts';

function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The plain model: a map from row to value, shifted by hand. */
type Plain = Map<number, number>;

function checkSame(column: Column, plain: Plain, label: string): void {
  const seen: [number, number][] = [];
  column.forEach(0, MAX_ROWS, (row, kind, value) => {
    assert.equal(kind, Kind.Number);
    seen.push([row, value]);
  });
  const expected = [...plain].sort((a, b) => a[0] - b[0]);
  assert.deepEqual(seen, expected, label);
  for (const [row, value] of expected) assert.equal(column.value(row), value, `${label}: value at ${row}`);
}

test('a column agrees with a plain map through sets, clears, inserts and deletes', () => {
  const next = random(11);
  const column = new Column();
  let plain: Plain = new Map();
  // Rows clustered near chunk edges and in one dense patch, so chunks split, join, and turn dense.
  const pick = () => (next() < 0.5 ? Math.floor(next() * 3 * CHUNK_ROWS) : CHUNK_ROWS - 50 + Math.floor(next() * 100));
  for (let step = 0; step < 4000; step++) {
    const op = next();
    const row = pick();
    if (op < 0.6) {
      const value = Math.round(next() * 1000);
      column.set(row, Kind.Number, value, 0);
      plain.set(row, value);
    } else if (op < 0.75) {
      column.set(row, Kind.Empty, 0, 0);
      plain.delete(row);
    } else if (op < 0.85) {
      const n = 1 + Math.floor(next() * (next() < 0.1 ? 10_000 : 40));
      column.insertRows(row, n);
      plain = new Map([...plain].map(([r, v]) => [r >= row ? r + n : r, v] as [number, number]).filter(([r]) => r < MAX_ROWS));
    } else {
      const n = 1 + Math.floor(next() * 40);
      column.deleteRows(row, n);
      plain = new Map([...plain].filter(([r]) => r < row || r >= row + n).map(([r, v]) => [r >= row + n ? r - n : r, v] as [number, number]));
    }
    if (step % 200 === 0) checkSame(column, plain, `step ${step}`);
  }
  checkSame(column, plain, 'end');
});

test('a snapshot keeps the column as it was while the column changes', () => {
  const column = new Column();
  for (let r = 0; r < 3000; r++) column.set(r, Kind.Number, r, 0);
  const before = column.snapshot();
  column.set(5, Kind.Number, -1, 0);
  column.insertRows(10, 5);
  assert.equal(column.value(5), -1);
  assert.equal(column.value(15), 10);
  column.restore(before);
  assert.equal(column.value(5), 5);
  assert.equal(column.value(10), 10);
  column.restore(before);
  assert.equal(column.value(5), 5, 'restoring twice does not share changes');
});

test('sparse chunks turn dense as they fill, and empty columns cost almost nothing', () => {
  const column = new Column();
  assert.equal(column.byteLength, 0);
  column.set(7, Kind.Number, 1, 0);
  const sparse = column.byteLength;
  assert.ok(sparse < 200, `one cell costs ${sparse} bytes`);
  for (let r = 0; r < CHUNK_ROWS; r++) column.set(r, Kind.Number, r, 0);
  const [{ chunk }] = column.chunks(0, 1);
  assert.ok(chunk.dense);
  assert.equal(column.extent(), CHUNK_ROWS);
});

test('formula runs move and split with inserted and deleted rows', () => {
  const column = new Column();
  for (let r = 10; r < 20; r++) column.addFormula(r, { text: 'A11*2', originRow: 10, originCol: 1, kind: 'shared', shared: 0 });
  assert.equal(column.formulas.length, 1);
  column.insertRows(15, 3);
  assert.deepEqual(column.formulas.map((f) => [f.first, f.last, f.originRow]), [[10, 14, 10], [18, 22, 10]]);
  column.insertRows(0, 2);
  assert.deepEqual(column.formulas.map((f) => [f.first, f.last, f.originRow]), [[12, 16, 12], [20, 24, 12]]);
  column.deleteRows(14, 8);
  assert.deepEqual(column.formulas.map((f) => [f.first, f.last]), [[12, 13], [14, 16]]);
  column.setFormula(15, null);
  assert.deepEqual(column.formulas.map((f) => [f.first, f.last]), [[12, 13], [14, 14], [16, 16]]);
  assert.equal(column.formulaAt(16)?.text, 'A11*2');
  assert.equal(column.formulaAt(15), undefined);
});

test('a grid keeps its extent through edits', () => {
  const grid = new Grid();
  grid.set(99, 3, Kind.Number, 1, 0);
  assert.deepEqual([grid.rows, grid.cols], [100, 4]);
  grid.deleteRows(50, 60);
  assert.deepEqual([grid.rows, grid.cols], [0, 0]);
  grid.set(0, 0, Kind.Number, 1, 0);
  grid.insertColumns(0, 2);
  assert.equal(grid.columns[2]!.value(0), 1);
  assert.deepEqual([grid.rows, grid.cols], [1, 3]);
});
