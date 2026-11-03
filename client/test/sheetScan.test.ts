import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ERRORS, Kind, columnIndex, columnName } from '../src/sheet/model/column.ts';
import { StringPool, unescapeXml } from '../src/sheet/model/strings.ts';
import { Worksheet, cellKey } from '../src/sheet/model/worksheet.ts';
import { SharedStringsScanner } from '../src/sheet/xlsx/sharedStrings.ts';
import { SheetScanner, isoToSerial, parseNumber } from '../src/sheet/xlsx/sheetScanner.ts';

const encode = (text: string) => new TextEncoder().encode(text);

/** Feeds `xml` to a scanner in pieces of `size` bytes. */
function scanSheet(xml: string, size = Infinity, strings = new StringPool()): { sheet: Worksheet; strings: StringPool; scanner: SheetScanner } {
  const sheet = new Worksheet('Sheet1', 1);
  const scanner = new SheetScanner(sheet, strings);
  const bytes = encode(xml);
  for (let at = 0; at < bytes.length; at += size) scanner.push(bytes.subarray(at, Math.min(bytes.length, at + size)));
  scanner.finish();
  return { sheet, strings, scanner };
}

const SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D4"/><cols><col min="1" max="1" width="12"/></cols><sheetData>` +
  `<row r="1" spans="1:4" ht="30" customHeight="1" x14ac:dyDescent="0.25"><c r="A1" t="s"><v>0</v></c><c r="B1" s="3"><v>12.5</v></c><c r="C1" t="b"><v>1</v></c><c r="D1" t="e"><v>#DIV/0!</v></c></row>` +
  `<row r="2" hidden="1" s="4" customFormat="1" outlineLevel="1" thickBot="1"><c r="A2"><v>-3</v></c><c r="B2" t="str"><f>"a"&amp;"b"</f><v xml:space="preserve">ab</v></c><c r="C2" s="2"/><c r="D2" t="inlineStr"><is><t>x &lt; y</t></is></c></row>` +
  `<row r="4"><c r="A4"><f t="shared" ref="A4:A6" si="0">B4*2</f><v>2</v></c><c><v>1E-7</v></c><c r="C4" t="str"><f>T(5)</f><v/></c><c r="D4" vm="1"><v>7</v></c></row>` +
  `<row r="5"><c r="A5"><f t="shared" si="0"/><v>4</v></c><c r="B5" cm="1"><f t="array" ref="B5:B7">_xlfn.SEQUENCE(3)</f><v>1</v></c><c r="C5" t="d"><v>2024-02-29T12:00:00</v></c></row>` +
  `<row r="6"><c r="A6"><f t="shared" si="0"/><v>6</v></c><c r="B6"><v>2</v></c><c r="D6"><f t="dataTable" ref="D6:D7" dt2D="0" dtr="0" r1="A1"/><v>3</v></c></row>` +
  `</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>`;

function check(sheet: Worksheet, strings: StringPool): void {
  const grid = sheet.grid;
  assert.equal(grid.rows, 6);
  assert.equal(grid.cols, 4);
  const [a, b, c, d] = [0, 1, 2, 3].map((i) => grid.columns[i]!);
  assert.equal(a.kind(0), Kind.String);
  assert.equal(a.value(0), 0);
  assert.deepEqual([b.kind(0), b.value(0), b.style(0)], [Kind.Number, 12.5, 3]);
  assert.deepEqual([c.kind(0), c.value(0)], [Kind.Boolean, 1]);
  assert.deepEqual([d.kind(0), ERRORS[d.value(0)]], [Kind.Error, '#DIV/0!']);
  assert.equal(a.value(1), -3);
  assert.equal(strings.get(b.value(1)), 'ab');
  assert.deepEqual([c.kind(1), c.style(1)], [Kind.Blank, 2]);
  assert.equal(strings.get(d.value(1)), 'x < y');
  assert.equal(a.kind(2), Kind.Empty);
  assert.equal(b.value(3), 1e-7, 'a cell with no r follows the one before it');
  assert.deepEqual([c.kind(3), strings.get(c.value(3))], [Kind.String, ''], 'an empty value (<v/>) is an empty string');
  assert.equal(c.value(4), 45351.5, 'an ISO date is its serial number');
  assert.deepEqual(
    a.formulas.map((f) => [f.first, f.last, f.text, f.originRow, f.kind]),
    [[3, 5, 'B4*2', 3, 'shared']],
    'a shared formula filled down is one run',
  );
  assert.deepEqual(b.formulas.map((f) => [f.first, f.text, f.kind, f.ref, f.dynamic]), [
    [1, '"a"&"b"', 'normal', undefined, undefined],
    [4, '_xlfn.SEQUENCE(3)', 'array', 'B5:B7', true],
  ]);
  assert.deepEqual(d.formulas.map((f) => [f.kind, f.ref, f.attrs]), [['dataTable', 'D6:D7', ' dt2D="0" dtr="0" r1="A1"']]);
  assert.equal(sheet.cellAttrs.get(cellKey(3, 3)), ' vm="1"');
  assert.equal(sheet.rowSizes.size(0), 30);
  assert.ok(sheet.rowSizes.hidden(1));
  assert.equal(sheet.rowStyles.get(1), 4);
  assert.deepEqual(sheet.rowOutline.get(1), { level: 1, collapsed: false });
  assert.equal(sheet.rowAttrs.get(1), ' thickBot="1"', 'attributes the model does not hold are kept; spans and dyDescent are not');
}

test('a sheet reads into columns', () => {
  const { sheet, strings, scanner } = scanSheet(SHEET);
  check(sheet, strings);
  const prefix = new TextDecoder().decode(Buffer.concat(scanner.prefix));
  const suffix = new TextDecoder().decode(Buffer.concat(scanner.suffix));
  assert.equal(prefix + '…' + suffix, SHEET.replace(/<sheetData>.*<\/sheetData>/s, '<sheetData>…</sheetData>'));
});

test('a sheet reads the same split into pieces anywhere', () => {
  for (const size of [1, 2, 3, 5, 7, 11, 64]) {
    const { sheet, strings } = scanSheet(SHEET, size);
    check(sheet, strings);
  }
});

test('tags with a namespace prefix read the same', () => {
  const prefixed = SHEET.replace(/<(\/?)(?!\?)([a-zA-Z])/g, '<$1x:$2').replace('<x:worksheet xmlns=', '<x:worksheet xmlns:x=');
  for (const size of [3, Infinity]) {
    const { sheet, strings } = scanSheet(prefixed, size);
    check(sheet, strings);
  }
});

test('an empty sheet keeps all its XML', () => {
  const xml = '<worksheet><sheetData/><pageMargins left="1"/></worksheet>';
  const { sheet, scanner } = scanSheet(xml, 4);
  assert.equal(sheet.grid.rows, 0);
  assert.equal(new TextDecoder().decode(Buffer.concat([...scanner.prefix, ...scanner.suffix])), xml);
});

test('rows report as each chunk of rows comes in', () => {
  const rows = Array.from({ length: 9000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
  const sheet = new Worksheet('S', 1);
  const scanner = new SheetScanner(sheet, new StringPool());
  const seen: number[] = [];
  scanner.onRows = (n) => seen.push(n);
  scanner.push(encode(`<worksheet><sheetData>${rows}</sheetData></worksheet>`));
  scanner.finish();
  assert.deepEqual(seen, [4096, 8192, 9000]);
  assert.equal(sheet.grid.columns[0]!.value(8999), 8999);
});

test('numbers read exactly as Number() reads them', () => {
  for (const text of ['0', '-0', '1', '12.5', '0.1', '0.30000000000000004', '123456789012345', '1234567890123456789', '3.14159265358979', '1E-7', '-2.5E+30', '45000.75', '0.000001']) {
    const bytes = encode(text);
    assert.equal(parseNumber(bytes, 0, bytes.length), Number(text), text);
  }
});

test('ISO dates to serial numbers, either side of 1 March 1900', () => {
  assert.equal(isoToSerial('1900-01-01'), 1);
  assert.equal(isoToSerial('1900-02-28'), 59);
  assert.equal(isoToSerial('1900-03-01'), 61);
  assert.equal(isoToSerial('2024-02-29T06:00:00'), 45351.25);
  assert.equal(isoToSerial('soon'), null);
});

test('shared strings: plain, rich, phonetic, escaped and empty', () => {
  const xml =
    '<sst count="5" uniqueCount="5"><si><t>plain</t></si><si><r><rPr><b/></rPr><t>bo</t></r><r><t xml:space="preserve">ld text</t></r></si>' +
    '<si><t>漢字</t><rPh sb="0" eb="2"><t>かんじ</t></rPh></si><si><t>a &amp; b_x000D_</t></si><si><t/></si></sst>';
  for (const size of [1, 3, 17, Infinity]) {
    const strings = new StringPool();
    const scanner = new SharedStringsScanner(strings);
    const bytes = encode(xml);
    for (let at = 0; at < bytes.length; at += size) scanner.push(bytes.subarray(at, Math.min(bytes.length, at + size)));
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => strings.get(i)), ['plain', 'bold text', '漢字', 'a & b\r', ''], `pieces of ${size}`);
  }
});

test('XML and Excel escapes', () => {
  assert.equal(unescapeXml('&lt;&#65;&#x42;&amp;amp;_x0009__x005F_x0041_'), '<AB&amp;\t_x0041_');
});

test('column names', () => {
  assert.deepEqual([0, 25, 26, 701, 702, 16383].map(columnName), ['A', 'Z', 'AA', 'ZZ', 'AAA', 'XFD']);
  assert.deepEqual(['A', 'z', 'AA', 'XFD', '1'].map(columnIndex), [0, 25, 26, 16383, -1]);
});
