import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpcPackage } from '@golemdocs/docx';
import { Workbook } from '../src/sheet/model/workbook.ts';
import { Worksheet } from '../src/sheet/model/worksheet.ts';
import { History } from '../src/sheet/edit.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';
import { writeWorkbook } from '../src/sheet/xlsx/write.ts';
import { hyperlinkArgument, linkAddress, linkAt, linkFromAddress, setLink } from '../src/sheet/links.ts';
import { look } from '../src/sheet/format/styleChange.ts';

const cell = (row: number, col: number) => ({ r0: row, c0: col, r1: row, c1: col });

function book(): { book: Workbook; sheet: Worksheet; history: History } {
  const b = new Workbook();
  const sheet = new Worksheet('Sheet1', 1);
  b.sheets.push(sheet);
  return { book: b, sheet, history: new History(b) };
}

test('a typed address is a link out of the workbook, or with # a place in it', () => {
  assert.deepEqual(linkFromAddress('https://example.com'), { target: 'https://example.com' });
  assert.deepEqual(linkFromAddress('#Sheet2!A1'), { location: 'Sheet2!A1' });
  assert.equal(linkAddress({ location: 'Sheet2!A1' }), '#Sheet2!A1');
  assert.equal(linkAddress({ target: 'mailto:a@b.c' }), 'mailto:a@b.c');
});

test('a range given a link replaces the links inside it; the last link over a cell is the one it has', () => {
  let links = setLink([], cell(0, 0), { target: 'https://a.example' });
  links = setLink(links, { r0: 0, c0: 0, r1: 2, c1: 0 }, { target: 'https://b.example' });
  assert.equal(links.length, 1);
  assert.equal(linkAt(links, 1, 0)?.target, 'https://b.example');
  links = setLink(links, cell(5, 5), { location: 'Sheet1!A1' });
  assert.equal(linkAt(links, 5, 5)?.location, 'Sheet1!A1');
  assert.equal(linkAt(links, 4, 4), undefined);
  assert.deepEqual(setLink(links, { r0: 0, c0: 0, r1: 9, c1: 9 }, null), []);
});

test('Insert › Hyperlink links the cell, shows the address in an empty one, looks like a link, and undoes', () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'link', range: cell(0, 0), link: { target: 'https://example.com' }, text: 'https://example.com' });
  assert.equal(sheet.links.length, 1);
  assert.equal(b.strings.get(sheet.grid.columns[0]!.value(0)), 'https://example.com');
  const style = look(b.styles, b.theme, sheet.grid.columns[0]!.style(0));
  assert.equal(style.underline, true);
  assert.equal(style.color, 0x0563c1);
  history.undo();
  assert.equal(sheet.links.length, 0);
  history.redo();
  assert.equal(sheet.links.length, 1);
  history.apply(0, { kind: 'link', range: cell(0, 0), link: null });
  assert.equal(sheet.links.length, 0);
  assert.equal(look(b.styles, b.theme, sheet.grid.columns[0]!.style(0)).underline, false);
});

test('links follow their cells when rows and columns are inserted or deleted', () => {
  const { sheet, history } = book();
  history.apply(0, { kind: 'link', range: cell(3, 1), link: { target: 'https://example.com' } });
  history.apply(0, { kind: 'insertRows', at: 0, count: 2 });
  assert.deepEqual(sheet.links[0].ref, cell(5, 1));
  history.apply(0, { kind: 'insertColumns', at: 0, count: 1 });
  assert.deepEqual(sheet.links[0].ref, cell(5, 2));
  history.apply(0, { kind: 'deleteRows', at: 5, count: 1 });
  assert.equal(sheet.links.length, 0);
  history.undo();
  assert.deepEqual(sheet.links[0].ref, cell(5, 2));
});

test('links are written as <hyperlinks>, an address out of the workbook as an external relationship, and read back', async () => {
  const { book: b, sheet, history } = book();
  history.apply(0, { kind: 'link', range: cell(0, 0), link: { target: 'https://example.com/a?b=1&c=2' }, text: 'Example' });
  history.apply(0, { kind: 'link', range: cell(1, 0), link: { location: "'Other sheet'!B2" }, text: 'There' });
  const bytes = await writeWorkbook(b);
  const pkg = await OpcPackage.read(bytes);
  const rels = (await pkg.relationships('xl/worksheets/sheet1.xml')).list.filter((r) => r.type.endsWith('/hyperlink'));
  assert.deepEqual(rels.map((r) => [r.target, r.external]), [['https://example.com/a?b=1&c=2', true]]);
  const xml = await pkg.text('xl/worksheets/sheet1.xml');
  assert.match(xml, /<hyperlinks><hyperlink ref="A1" r:id="rId\d+"\/><hyperlink ref="A2" location="'Other sheet'!B2"\/><\/hyperlinks>/);
  const back = (await readWorkbook(bytes)).sheets[0] as Worksheet;
  assert.deepEqual(
    back.links.map((l) => [l.ref.r0, l.target, l.location]),
    [
      [0, 'https://example.com/a?b=1&c=2', undefined],
      [1, undefined, "'Other sheet'!B2"],
    ],
  );
  // Taking the link away takes its relationship with it.
  history.apply(0, { kind: 'link', range: cell(0, 0), link: null });
  const after = await OpcPackage.read(await writeWorkbook(b));
  assert.deepEqual((await after.relationships('xl/worksheets/sheet1.xml')).list.filter((r) => r.type.endsWith('/hyperlink')), []);
  assert.equal(sheet.links.length, 1);
});

test('a HYPERLINK formula goes to its first argument: a quoted address, or the cell that holds one', () => {
  assert.deepEqual(hyperlinkArgument('=HYPERLINK("https://example.com/?q=""a""", "Example")'), { address: 'https://example.com/?q="a"' });
  assert.deepEqual(hyperlinkArgument('= hyperlink( "#Sheet2!A1" )'), { address: '#Sheet2!A1' });
  assert.deepEqual(hyperlinkArgument('=_xlfn.HYPERLINK($b$2,"Go")'), { cell: 'B2' });
  // Worked out otherwise, empty, or another function: nothing to follow.
  assert.equal(hyperlinkArgument('=HYPERLINK("https://" & A1, "Go")'), null);
  assert.equal(hyperlinkArgument('=HYPERLINK("")'), null);
  assert.equal(hyperlinkArgument('=SUM(A1:A3)'), null);
  assert.equal(hyperlinkArgument('HYPERLINK("https://example.com")'), null);
});

test('a protected sheet refuses a link on a locked cell, and takes one on an unlocked cell', () => {
  const { sheet, history } = book();
  history.apply(0, { kind: 'input', range: cell(0, 0), text: 'locked' });
  history.apply(0, { kind: 'format', ranges: [cell(0, 1)], change: { locked: false } });
  history.apply(0, { kind: 'protect', on: true, password: '' });
  const link = { target: 'https://example.com' };
  assert.equal(history.apply(0, { kind: 'link', range: cell(0, 0), link, text: 'changed' }).message, 'sheetProtected');
  assert.equal(sheet.links.length, 0);
  assert.equal(history.apply(0, { kind: 'link', range: cell(0, 1), link }).message, undefined);
  assert.equal(sheet.links.length, 1);
});
