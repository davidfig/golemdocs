import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromFileFormula, toFileFormula } from '../src/sheet/formula/fileNames.ts';

test('newer functions get their file prefix, older ones and strings do not', () => {
  assert.equal(toFileFormula('XLOOKUP(A1,B:B,C:C)+SUM(1)'), '_xlfn.XLOOKUP(A1,B:B,C:C)+SUM(1)');
  assert.equal(toFileFormula('FILTER(A1:A9,SORT(B1:B9)>1)'), '_xlfn._xlws.FILTER(A1:A9,_xlfn._xlws.SORT(B1:B9)>1)');
  assert.equal(toFileFormula('T.INV.2T(0.05,10)&"XLOOKUP(x)"'), '_xlfn.T.INV.2T(0.05,10)&"XLOOKUP(x)"');
  assert.equal(toFileFormula('"a""SEQUENCE(1)"&SEQUENCE(2)'), '"a""SEQUENCE(1)"&_xlfn.SEQUENCE(2)');
});

test('file prefixes come off, inside strings they stay', () => {
  assert.equal(fromFileFormula('_xlfn._xlws.SORT(_xlfn.UNIQUE(A:A))&"_xlfn.X"'), 'SORT(UNIQUE(A:A))&"_xlfn.X"');
  assert.equal(fromFileFormula('_xlfn.LET(_xlpm.x,1,_xlpm.x+1)'), 'LET(x,1,x+1)');
});
