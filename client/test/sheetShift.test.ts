import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shiftFormula } from '../src/sheet/formula/shift.ts';

test('relative references move, absolute ones stay', () => {
  assert.equal(shiftFormula('B4*2', 1, 0), 'B5*2');
  assert.equal(shiftFormula('$B$4+B$4+$B4', 2, 3), '$B$4+E$4+$B6');
  assert.equal(shiftFormula('SUM(A1:B10)', 5, 1), 'SUM(B6:C15)');
  assert.equal(shiftFormula('SUM(A:A)+SUM(3:3)', 1, 1), 'SUM(B:B)+SUM(4:4)');
  assert.equal(shiftFormula('Data!A1+\'My Sheet\'!B2', 1, 0), 'Data!A2+\'My Sheet\'!B3');
});

test('strings, functions, names and structured references are left alone', () => {
  assert.equal(shiftFormula('"A1"&A1', 1, 0), '"A1"&A2');
  assert.equal(shiftFormula('LOG10(A1)+ATAN2(B1,C1)', 1, 0), 'LOG10(A2)+ATAN2(B2,C2)');
  assert.equal(shiftFormula('Table1[Amount]*A1', 1, 0), 'Table1[Amount]*A2');
  assert.equal(shiftFormula('_xlfn.XLOOKUP(A1,B:B,C:C)', 1, 0), '_xlfn.XLOOKUP(A2,B:B,C:C)');
  assert.equal(shiftFormula('TAXES2024*A1', 1, 0), 'TAXES2024*A2', 'a name that cannot be a cell (TAX2024 can: column TAX) is a name');
});

test('references pushed off the sheet become #REF!', () => {
  assert.equal(shiftFormula('A1+1', -1, 0), '#REF!+1');
  assert.equal(shiftFormula('XFD1', 0, 1), '#REF!');
  assert.equal(shiftFormula('Data!A1:B2', -1, 0), 'Data!#REF!');
});
