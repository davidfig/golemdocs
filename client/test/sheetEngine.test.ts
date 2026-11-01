// The formula engine: parsing, what an edit makes out of date, recalculation, spills and circular references.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { History } from '../src/sheet/edit.ts';
import { Engine } from '../src/sheet/formula/engine.ts';
import { compile } from '../src/sheet/formula/evaluate.ts';
import { ConditionalPainter, readConditional } from '../src/sheet/conditional.ts';
import { readTable, resolveStructured, tablePaint } from '../src/sheet/tables.ts';
import { OFFICE_THEME } from '../src/sheet/model/theme.ts';
import { readFileSync } from 'node:fs';
import { TileCache, cellTile } from '../src/sheet/tiles.ts';
import { parseXml } from '@golemdocs/docx';
import { fromFileFormula, toFileFormula } from '../src/sheet/formula/fileNames.ts';
import { CATALOGUE } from '../src/sheet/formula/functions/catalogue.ts';
import { FUNCTIONS } from '../src/sheet/formula/functions/index.ts';
import { moveText } from '../src/sheet/formula/move.ts';
import { parseFormula } from '../src/sheet/formula/parser.ts';
import type { Host } from '../src/sheet/formula/runtime.ts';
import { ArrayValue, BLANK, FormulaError } from '../src/sheet/formula/values.ts';
import type { Scalar } from '../src/sheet/formula/values.ts';
import { ERRORS, Kind } from '../src/sheet/model/column.ts';
import { Workbook } from '../src/sheet/model/workbook.ts';
import { Worksheet } from '../src/sheet/model/worksheet.ts';
import { parseRange, rangeName } from '../src/sheet/refs.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';
import { writeWorkbook } from '../src/sheet/xlsx/write.ts';

/** A workbook with an engine; `type` enters text into cells as a person does and recalculates. */
function sheet(...names: string[]) {
  const book = new Workbook();
  for (const [i, name] of (names.length ? names : ['Sheet1']).entries()) book.sheets.push(new Worksheet(name, i + 1));
  const history = new History(book);
  const engine = new Engine(book);
  const type = (ref: string, text: string, sheetIndex = 0) => {
    const range = parseRange(ref)!;
    history.apply(sheetIndex, { kind: 'input', range, text });
    engine.formulasChanged();
    return engine.recalculate([{ sheet: sheetIndex, ...range }]);
  };
  const get = (ref: string, sheetIndex = 0): Scalar => {
    const { r0, c0 } = parseRange(ref)!;
    const column = (book.sheets[sheetIndex] as Worksheet).grid.columns[c0];
    const v = column?.value(r0) ?? 0;
    switch (column?.kind(r0) ?? Kind.Empty) {
      case Kind.Number:
        return v;
      case Kind.String:
        return book.strings.get(v);
      case Kind.Boolean:
        return v !== 0;
      case Kind.Error:
        return ERRORS[v];
      default:
        return BLANK;
    }
  };
  return { book, history, engine, type, get };
}

test('the parser follows Excel’s precedence', () => {
  const calc = (f: string) => compile(f).run({ host: { name: () => null } as unknown as Host, sheet: 0, row: 0, col: 0, dRow: 0, dCol: 0, dynamic: true, scope: null });
  assert.equal(calc('-2^2'), 4);
  assert.equal(calc('2^3^2'), 64);
  assert.equal(calc('1+2*3'), 7);
  assert.equal(calc('"a"&1+2'), 'a3');
  assert.equal(calc('50%*2'), 1);
  assert.equal(calc('1=1.0'), true);
  assert.equal(calc('IF(1>2,"x")'), false);
  assert.equal(calc('LET(x,2,y,x*3,x+y)'), 8);
  assert.equal(calc('LAMBDA(a,b,a*b)(3,4)'), 12);
  assert.equal(calc('_xlfn.CONCAT("a","b")'), 'ab');
  assert.equal(calc('SUM(1,,2)'), 3);
  assert.deepEqual(calc('{1,2;3,4}'), new ArrayValue(2, 2, [1, 2, 3, 4]));
  assert.equal(calc('NOSUCHFUNCTION(1)'), FormulaError.of('#NAME?'));
  assert.equal(compile('1+').invalid, true);
  assert.equal(compile('NOW()').volatile, true);
});

test('references parse on other sheets, across sheets and quoted', () => {
  assert.deepEqual(parseFormula("'My Sheet'!$A$1"), { t: 'cell', sheet: { first: 'My Sheet' }, row: { i: 0, abs: true }, col: { i: 0, abs: true } });
  assert.equal(parseFormula('Q1!B2').t, 'cell');
  const three = parseFormula('SUM(Jan:Mar!A1)');
  assert.ok(three.t === 'func' && three.args[0].t === 'cell' && three.args[0].sheet?.last === 'Mar');
  assert.equal(parseFormula('A:C').t, 'cols');
  assert.equal(parseFormula('3:5').t, 'rows');
});

test('typing a value recalculates what reads it, and what reads that', () => {
  const s = sheet();
  s.type('A1', '2');
  s.type('B1', '=A1*10');
  s.type('C1', '=B1+1');
  assert.equal(s.get('B1'), 20);
  assert.equal(s.get('C1'), 21);
  const changed = s.type('A1', '5');
  assert.equal(s.get('B1'), 50);
  assert.equal(s.get('C1'), 51);
  assert.ok(changed.some((b) => b.c0 === 2 && b.r0 === 0), 'C1 is among the cells that changed');
});

test('a formula filled down a column recalculates only the rows that read a changed cell', () => {
  const s = sheet();
  s.type('A1:A1000', '1');
  s.type('B1:B1000', '=A1*2');
  assert.equal(s.get('B500'), 2);
  const changed = s.type('A500', '7');
  assert.equal(s.get('B500'), 14);
  assert.equal(s.get('B501'), 2);
  const rows = changed.filter((b) => b.c0 === 1).reduce((n, b) => n + b.r1 - b.r0 + 1, 0);
  assert.equal(rows, 1, 'one cell of the run was calculated');
});

test('running totals and absolute references', () => {
  const s = sheet();
  s.type('A1:A5', '1');
  s.type('B1:B5', '=SUM($A$1:A1)');
  assert.equal(s.get('B5'), 5);
  s.type('A2', '10');
  assert.equal(s.get('B1'), 1);
  assert.equal(s.get('B2'), 11);
  assert.equal(s.get('B5'), 14);
});

test('a long chain of formulas is calculated without running out of stack', () => {
  const s = sheet();
  s.type('A1', '1');
  s.type('A2:A20000', '=A1+1');
  assert.equal(s.get('A20000'), 20000);
  s.type('A1', '100');
  assert.equal(s.get('A20000'), 20099);
});

test('a chain that runs up the sheet is calculated from its far end', () => {
  const s = sheet();
  s.type('A5000', '1');
  s.type('A1:A4999', '=A2+1');
  assert.equal(s.get('A1'), 5000);
});

test('formulas on other sheets, by name', () => {
  const s = sheet('Data', 'Report');
  s.type('A1', '3', 0);
  s.type('A1', '=Data!A1*2', 1);
  assert.equal(s.get('A1', 1), 6);
  s.type('A1', '4', 0);
  assert.equal(s.get('A1', 1), 8);
});

test('defined names are read through', () => {
  const s = sheet();
  s.book.names.push({ name: 'Rate', formula: 'Sheet1!$A$1' });
  s.type('A1', '0.5');
  s.type('B1', '=Rate*100');
  assert.equal(s.get('B1'), 50);
  s.type('A1', '0.25');
  assert.equal(s.get('B1'), 25);
});

test('a dynamic array spills, is blocked by a value, and spills again when it is cleared', () => {
  const s = sheet();
  s.type('A1', '=SEQUENCE(3)');
  assert.deepEqual([s.get('A1'), s.get('A2'), s.get('A3')], [1, 2, 3]);
  s.type('A2', 'x');
  assert.equal(s.get('A1'), '#SPILL!');
  assert.equal(s.get('A3'), BLANK, 'the spill is taken back');
  s.type('A2', '');
  assert.deepEqual([s.get('A1'), s.get('A2'), s.get('A3')], [1, 2, 3]);
});

test('formulas reading a spill recalculate when it changes', () => {
  const s = sheet();
  s.type('C1', '3');
  s.type('A1', '=SEQUENCE(C1)');
  s.type('B1', '=SUM(A1#)');
  s.type('B2', '=A3*10');
  assert.equal(s.get('B1'), 6);
  assert.equal(s.get('B2'), 30);
  s.type('C1', '2');
  assert.equal(s.get('A3'), BLANK);
  assert.equal(s.get('B1'), 3);
  assert.equal(s.get('B2'), 0);
});

test('a circular reference gives 0 and does not hang', () => {
  const s = sheet();
  s.type('A1', '=B1+1');
  s.type('B1', '=A1+1');
  assert.equal(typeof s.get('A1'), 'number');
  assert.equal(typeof s.get('B1'), 'number');
});

test('volatile functions recalculate on every change', () => {
  const s = sheet();
  s.type('A1', '=RAND()');
  const first = s.get('A1');
  s.type('C9', '1');
  assert.notEqual(s.get('A1'), first);
});

test('a spilled formula is written as Excel writes one, with the metadata it needs, and reads back', async () => {
  const s = sheet();
  s.type('A1', '=SEQUENCE(2,2)');
  s.type('D1', '=1+1');
  const bytes = await writeWorkbook(s.book, { recalculate: false });
  const back = await readWorkbook(bytes);
  const grid = (back.sheets[0] as Worksheet).grid;
  const run = grid.columns[0]!.formulaAt(0)!;
  assert.equal(run.kind, 'array');
  assert.equal(run.ref, 'A1:B2');
  assert.ok(run.dynamic);
  assert.equal(grid.columns[1]!.value(1), 4);
  assert.equal(grid.columns[3]!.formulaAt(0)!.kind, 'normal');
  assert.ok(back.source!.pkg.has('xl/metadata.xml'));
  // Read back, the spill is known: recalculating does not block it with its own values.
  const engine = new Engine(back);
  engine.recalculateAll();
  assert.equal(grid.columns[1]!.value(1), 4);
  assert.equal(grid.columns[0]!.kind(0), Kind.Number);
});

test('undoing an edit and recalculating restores the old results', () => {
  const s = sheet();
  s.type('A1', '2');
  s.type('B1', '=A1*3');
  s.type('A1', '5');
  assert.equal(s.get('B1'), 15);
  s.history.undo();
  s.engine.formulasChanged();
  s.engine.recalculate([{ sheet: 0, r0: 0, c0: 0, r1: 0, c1: 1 }]);
  assert.equal(s.get('B1'), 6);
});

test('references follow inserted and deleted rows and columns, as in Excel', () => {
  const rows = (t: string, at: number, n: number) => moveText(t, 'S', 'S', 'row', at, n);
  assert.equal(rows('A5+$B$5+A1', 2, 3), 'A8+$B$8+A1');
  assert.equal(rows('SUM(A1:A10)', 4, 2), 'SUM(A1:A12)', 'a range grows when rows go in inside it');
  assert.equal(rows('SUM(A1:A10)', 2, -3), 'SUM(A1:A7)', 'and shrinks when some of its rows go');
  assert.equal(rows('SUM(A3:A4)+A3', 2, -2), 'SUM(#REF!)+#REF!');
  assert.equal(rows('Other!A5+A5', 0, 1), 'Other!A5+A6', 'another sheet’s references stay');
  assert.equal(moveText('S!A5+A5', 'Other', 'S', 'row', 0, 1), 'S!A6+A5');
  assert.equal(rows('"A5"&A5', 0, 1), '"A5"&A6', 'text in quotes is left alone');
  assert.equal(rows('A:A+3:5', 0, 2), 'A:A+5:7');
  assert.equal(moveText('B1+$C$2+A:C', 'S', 'S', 'col', 1, 1), 'C1+$D$2+A:D');
  assert.equal(moveText('B1+C1', 'S', 'S', 'col', 1, -1), '#REF!+B1');
});

const formulaAt = (s: ReturnType<typeof sheet>, ref: string, sheetIndex = 0) => {
  const { r0, c0 } = parseRange(ref)!;
  return s.engine.formulaText(sheetIndex, r0, c0);
};

test('inserting rows moves formulas and their references, and recalculates', () => {
  const s = sheet();
  s.type('A1:A10', '1');
  s.type('B1:B10', '=A1*2');
  s.type('C1', '=SUM(A1:A10)');
  s.history.apply(0, { kind: 'insertRows', at: 4, count: 2 });
  s.engine.formulasChanged();
  s.engine.recalculate([{ sheet: 0, r0: 4, c0: 0, r1: 1048575, c1: 16383 }]);
  assert.equal(formulaAt(s, 'C1'), '=SUM(A1:A12)');
  assert.equal(formulaAt(s, 'B4'), '=A4*2');
  assert.equal(formulaAt(s, 'B5'), null, 'the new rows are empty');
  assert.equal(formulaAt(s, 'B7'), '=A7*2');
  assert.equal(s.get('C1'), 10);
  s.type('A5', '100');
  assert.equal(s.get('C1'), 110);
});

test('a run above an insert that reads below it is cut where its references start to move', () => {
  const s = sheet();
  s.type('A1:A10', '1');
  // Each cell of B1:B5 reads the cell five rows down; an insert of two rows at row 4 moves A6 and below, not A4 or A5.
  s.type('B1:B5', '=A6');
  s.history.apply(0, { kind: 'insertRows', at: 3, count: 2 });
  assert.equal(formulaAt(s, 'B1'), '=A8', 'B1 read A6, now at A8');
  assert.equal(formulaAt(s, 'B3'), '=A10');
  assert.equal(formulaAt(s, 'B6'), '=A11', 'the cells below the insert moved with what they read');
  assert.equal(formulaAt(s, 'B4'), null);
});

test('renaming a sheet renames references to it, and undo puts them back', () => {
  const s = sheet('Data', 'Report');
  s.type('A1', '=Data!A1+1', 1);
  s.history.apply(0, { kind: 'renameSheet', sheet: 0, name: 'My Data' });
  assert.equal(formulaAt(s, 'A1', 1), "='My Data'!A1+1");
  s.history.undo();
  assert.equal(formulaAt(s, 'A1', 1), '=Data!A1+1');
});

test('deleting a sheet turns references to it into #REF!', () => {
  const s = sheet('Data', 'Report');
  s.type('A1', '5', 0);
  s.type('A1', '=Data!A1*2', 1);
  assert.equal(s.get('A1', 1), 10);
  s.history.apply(0, { kind: 'deleteSheet', sheet: 0 });
  const engine = new Engine(s.book);
  engine.recalculateAll();
  assert.equal(engine.formulaText(0, 0, 0), '=#REF!*2');
  assert.equal(s.get('A1', 0), '#REF!');
});

test('the engine says when a workbook uses what it cannot calculate yet', () => {
  const s = sheet();
  s.type('A1', '=SUM(1,2)');
  assert.equal(s.engine.incomplete, false);
  s.type('A2', '=NOTAFUNCTION(1)');
  assert.equal(s.engine.incomplete, true);
});

test('every function Excel has is defined, except those that reach outside the workbook', () => {
  const missing = Object.entries(CATALOGUE)
    .filter(([category]) => category !== 'external')
    .flatMap(([, names]) => names.filter((n) => !FUNCTIONS.has(n) && n !== 'LET' && n !== 'LAMBDA'));
  assert.deepEqual(missing, []);
});

test('LET and LAMBDA parameters and functions passed by name are written as Excel writes them', () => {
  assert.equal(toFileFormula('LET(x,2,x*3)'), '_xlfn.LET(_xlpm.x,2,_xlpm.x*3)');
  assert.equal(toFileFormula('MAP({1,2},LAMBDA(v,v*2))'), '_xlfn.MAP({1,2},_xlfn.LAMBDA(_xlpm.v,_xlpm.v*2))');
  assert.equal(toFileFormula('GROUPBY(A1:A5,B1:B5,SUM)'), '_xlfn.GROUPBY(A1:A5,B1:B5,_xleta.SUM)');
  assert.equal(toFileFormula('SUM(A1)+Data!B2'), 'SUM(A1)+Data!B2');
  assert.equal(fromFileFormula('_xlfn.GROUPBY(A1:A5,B1:B5,_xleta.SUM)'), 'GROUPBY(A1:A5,B1:B5,SUM)');
});

test('a function passed by name is the function', () => {
  const s = sheet();
  s.type('A1', '=BYROW({1,2;3,4},SUM)');
  assert.deepEqual([s.get('A1'), s.get('A2')], [3, 7]);
});

test('a formula reaching outside the workbook keeps the value it was saved with', () => {
  const s = sheet();
  s.type('A1', '=WEBSERVICE("http://example.com")');
  const sheet0 = s.book.sheets[0] as Worksheet;
  sheet0.grid.set(0, 0, Kind.Number, 42, 0);
  s.engine.recalculateAll();
  assert.equal(s.get('A1'), 42);
});

test('conditional formats: rules over cells, formulas, ranks, scales and bars', () => {
  const s = sheet();
  s.type('A1:A5', '=ROW()*10');
  s.type('B1', 'apple');
  s.type('B2', 'pear');
  s.type('B3', 'apple');
  const ws = s.book.sheets[0] as Worksheet;
  // dxf 0: bold; dxf 1: a red fill.
  s.book.styles.dxfs.push({ font: { bold: true } }, { fill: { pattern: 'solid', bg: { rgb: 0xff0000 } } });
  ws.conditional = readConditional(
    parseXml(`<worksheet>
      <conditionalFormatting sqref="A1:A5"><cfRule type="cellIs" dxfId="0" priority="2" operator="greaterThan"><formula>25</formula></cfRule></conditionalFormatting>
      <conditionalFormatting sqref="A1:A5"><cfRule type="top10" dxfId="1" priority="1" rank="1"/></conditionalFormatting>
      <conditionalFormatting sqref="B1:B3"><cfRule type="duplicateValues" dxfId="1" priority="3"/></conditionalFormatting>
      <conditionalFormatting sqref="C1:C5"><cfRule type="expression" dxfId="0" priority="4"><formula>$A1=20</formula></cfRule></conditionalFormatting>
      <conditionalFormatting sqref="D1:D5"><cfRule type="colorScale" priority="5"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FF000000"/><color rgb="FFFFFFFF"/></colorScale></cfRule></conditionalFormatting>
      <conditionalFormatting sqref="A1:A5"><cfRule type="dataBar" priority="6"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar></cfRule></conditionalFormatting>
    </worksheet>`),
  );
  s.type('D1', '0');
  s.type('D2', '50');
  s.type('D3', '100');
  const painter = new ConditionalPainter(s.engine, 0, ws, (c) => ('rgb' in c ? c.rgb & 0xffffff : 0));
  assert.equal(painter.overlay(0, 0)?.dxfs.length ?? 0, 0, 'A1 (10) is neither above 25 nor the top value');
  assert.deepEqual(painter.overlay(2, 0)?.dxfs, [0], 'A3 (30) is above 25');
  assert.deepEqual(painter.overlay(4, 0)?.dxfs, [1, 0], 'A5 (50): the top value (priority 1) and above 25');
  assert.equal(painter.overlay(4, 0)?.bar?.to, 0.9, 'the largest value has the longest bar');
  assert.deepEqual(painter.overlay(0, 1)?.dxfs, [1], 'apple is duplicated');
  assert.equal(painter.overlay(1, 1), null, 'pear is not');
  assert.deepEqual(painter.overlay(1, 2)?.dxfs, [0], 'the expression moves with the row: $A2=20');
  assert.equal(painter.overlay(1, 3)?.fill, 0x808080, 'the middle of a black-to-white scale is grey');
  // In a tile, the overlay is a style of its own.
  const cache = new TileCache(s.book);
  const tile = cellTile(s.book, 0, ws, { level: 0, tx: 0, ty: 0 }, cache, painter);
  const a5 = tile.cells.find((c) => c.row === 4 && c.col === 0)!;
  const style = tile.styles.find(([i]) => i === a5.style)![1];
  assert.equal(style.bold, true);
  assert.equal(style.fill, 0xff0000);
});

test('conditional formats follow inserted rows, are written back, and undo puts them back', async () => {
  const s = sheet();
  s.type('A1:A5', '1');
  const ws = s.book.sheets[0] as Worksheet;
  s.book.styles.dxfs.push({ font: { bold: true } });
  ws.conditional = readConditional(parseXml(`<worksheet><conditionalFormatting sqref="A2:A5 C1"><cfRule type="expression" dxfId="0" priority="1"><formula>$A2&gt;$B$9</formula></cfRule></conditionalFormatting></worksheet>`));
  s.history.apply(0, { kind: 'insertRows', at: 2, count: 3 });
  assert.deepEqual(ws.conditional[0].ranges.map((r) => rangeName(r)), ['A2:A8', 'C1']);
  assert.equal(ws.conditional[0].rules[0].formulas[0], '$A2>$B$12');
  const back = await readWorkbook(await writeWorkbook(s.book, { recalculate: false }));
  const read = (back.sheets[0] as Worksheet).conditional;
  assert.deepEqual(read[0].ranges.map((r) => rangeName(r)), ['A2:A8', 'C1']);
  assert.equal(read[0].rules[0].formulas[0], '$A2>$B$12');
  s.history.undo();
  assert.deepEqual(ws.conditional[0].ranges.map((r) => rangeName(r)), ['A2:A5', 'C1']);
});

test('tables: structured references name their ranges, and [@Column] typed in a table reads its own row', async () => {
  const fixture = await readWorkbook(readFileSync(new URL('./fixtures/sheets/oracle/tables.xlsx', import.meta.url)));
  const data = fixture.sheets[1] as Worksheet;
  const sales = data.tables[0];
  assert.equal(sales.displayName, 'Sales');
  assert.deepEqual(sales.columns, ['Name', 'Region', 'Sales']);
  const at = (spec: string, row = 0) => {
    const r = resolveStructured(sales, spec, row);
    return r && rangeName(r);
  };
  assert.equal(at('[Sales]'), 'K2:K6');
  assert.equal(at('[#All]'), 'I1:K6');
  assert.equal(at('[[#Headers],[Name]:[Region]]'), 'I1:J1');
  assert.equal(at('[@Region]', 3), 'J4');
  assert.equal(at('[[#This Row],[Sales]]', 0), null, 'the header row is not a data row');
  assert.equal(at('[Nope]'), null);

  // A table typed into: [@Column] in a new column of it reads its own row, and is written as Excel writes it.
  const s = sheet();
  s.type('A1', 'Price');
  s.type('B1', 'Qty');
  s.type('C1', 'Total');
  s.type('A2', '3');
  s.type('B2', '4');
  s.type('A3', '5');
  s.type('B3', '6');
  const ws = s.book.sheets[0] as Worksheet;
  ws.tables = [readTable(parseXml('<table id="1" name="T" displayName="T" ref="A1:C3"><tableColumns count="3"><tableColumn id="1" name="Price"/><tableColumn id="2" name="Qty"/><tableColumn id="3" name="Total"/></tableColumns><tableStyleInfo name="TableStyleMedium2" showRowStripes="1"/></table>'), 'xl/tables/table1.xml')!];
  s.engine.formulasChanged();
  s.type('C2:C3', '=[@Price]*[@Qty]');
  assert.deepEqual([s.get('C2'), s.get('C3')], [12, 30]);
  assert.equal(ws.grid.columns[2]!.formulaAt(1)!.text, 'T[[#This Row],[Price]]*T[[#This Row],[Qty]]');
  s.type('D1', '=SUM(T[Total])');
  assert.equal(s.get('D1'), 42);
  s.type('A3', '10');
  assert.equal(s.get('D1'), 72, 'a total over a table column follows its cells');
  // Rows inserted inside the table grow it; its header is painted by its style.
  s.history.apply(0, { kind: 'insertRows', at: 2, count: 1 });
  assert.equal(rangeName(ws.tables[0].range), 'A1:C4');
  const header = tablePaint(ws.tables[0], 0, 0, OFFICE_THEME.colors.slice(4, 10), 0);
  assert.equal(header?.fill, OFFICE_THEME.colors[4], 'Medium2 heads the table in accent 1');
  assert.equal(tablePaint(ws.tables[0], 1, 0, OFFICE_THEME.colors.slice(4, 10), 0)?.fill !== undefined, true, 'the first data row is banded');
});
