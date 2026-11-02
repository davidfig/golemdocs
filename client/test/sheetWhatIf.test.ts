// What-if analysis: Goal Seek finds the value of a cell that brings a formula to a goal, and leaves the cell as it was.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { History } from '../src/sheet/edit.ts';
import { Engine } from '../src/sheet/formula/engine.ts';
import { Kind } from '../src/sheet/model/column.ts';
import { Workbook } from '../src/sheet/model/workbook.ts';
import { Worksheet } from '../src/sheet/model/worksheet.ts';
import { parseRange } from '../src/sheet/refs.ts';
import { goalSeek } from '../src/sheet/whatIf.ts';

function book(cells: Record<string, string>) {
  const b = new Workbook();
  const sheet = new Worksheet('Sheet1', 1);
  b.sheets.push(sheet);
  const history = new History(b);
  for (const [ref, text] of Object.entries(cells)) history.apply(0, { kind: 'input', range: parseRange(ref)!, text });
  const engine = new Engine(b);
  engine.recalculateAll();
  const at = (ref: string) => {
    const r = parseRange(ref)!;
    return { row: r.r0, col: r.c0 };
  };
  return { sheet, engine, at };
}

test('Goal Seek finds the input that brings a formula to its goal, and puts the input back', () => {
  const { sheet, engine, at } = book({ A1: '5', B1: '=A1^2+3' });
  const r = goalSeek(engine, sheet, 0, at('B1'), 30, at('A1'));
  assert.ok(r.found);
  assert.ok(Math.abs(r.value - Math.sqrt(27)) < 1e-6, String(r.value));
  assert.ok(Math.abs(r.result! - 30) < 1e-6);
  assert.equal(sheet.grid.columns[0]!.value(0), 5);
  assert.equal(engine.value(0, 0, 1), 28);
});

test('Goal Seek finds a loan’s rate through PMT, from an empty cell', () => {
  // The monthly rate that makes a 200,000 loan over 360 months cost 1,200 a month.
  const { sheet, engine, at } = book({ B1: '=PMT(A1,360,-200000)' });
  const r = goalSeek(engine, sheet, 0, at('B1'), 1200, at('A1'));
  assert.ok(r.found, JSON.stringify(r));
  assert.ok(Math.abs(r.result! - 1200) <= 0.001);
  assert.ok(r.value > 0.004 && r.value < 0.006, String(r.value));
  assert.equal(sheet.grid.columns[0]?.kind(0) ?? Kind.Empty, Kind.Empty);
});

test('Goal Seek says when no value reaches the goal, and when the cells are the wrong kind', () => {
  const { sheet, engine, at } = book({ A1: '2', B1: '=A1^2' });
  const r = goalSeek(engine, sheet, 0, at('B1'), -1, at('A1'));
  assert.equal(r.found, false);
  assert.equal(sheet.grid.columns[0]!.value(0), 2);
  assert.equal(goalSeek(engine, sheet, 0, at('A1'), 1, at('B1')).message, 'goalSeekTarget');
  assert.equal(goalSeek(engine, sheet, 0, at('B1'), 1, at('B1')).message, 'goalSeekChanging');
});
