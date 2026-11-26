import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { OpcPackage, parseXml, serializeXml } from '@golemdocs/docx';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';
import { writeWorkbook } from '../src/sheet/xlsx/write.ts';
import { History } from '../src/sheet/edit.ts';
import type { Worksheet } from '../src/sheet/model/worksheet.ts';
import { anchorBox, shapeOfAnchor, type DrawingEdit } from '../src/sheet/drawings.ts';
import { printLayout } from '../src/sheet/print.ts';
import { recolorFor } from '../src/sheet/drawingLayer.ts';
import { darkPageColor } from '../src/webgl/program.ts';

// charts-excel.xlsx (saved by Excel) with a picture and a shape added in Excel's markup (see the fixture's name).
const FIXTURE = readFileSync('test/fixtures/sheets/drawings-handmade.xlsx');

const open = async () => {
  const book = await readWorkbook(FIXTURE);
  return { book, sheet: book.sheets[0] as Worksheet, history: new History(book) };
};
/** The page's edits that change nothing: each drawing as it is. */
const asIs = (sheet: Worksheet): DrawingEdit[] =>
  sheet.drawings.map((d, i) => ({ shape: shapeXml(d.xml), box: anchorBox(sheet.rowSizes, sheet.colSizes, d.anchor), rels: d.rels, source: i }));
const shapeXml = (anchor: string) => {
  // As the page sends it: the shape alone, the namespaces it uses declared on it.
  const shape = shapeOfAnchor(parseXml(anchor))!;
  Object.assign(shape.attrs, { 'xmlns:xdr': 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing', 'xmlns:a': 'http://schemas.openxmlformats.org/drawingml/2006/main', 'xmlns:r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships' });
  return serializeXml(shape);
};
const drawingPart = async (bytes: Uint8Array) => (await OpcPackage.read(bytes)).text('xl/drawings/drawing1.xml');

test('a sheet’s pictures and shapes are read beside its charts, each with where it is and the image it shows', async () => {
  const { sheet } = await open();
  assert.equal(sheet.charts.length, 7);
  assert.equal(sheet.drawings.length, 2);
  const [pic, sp] = sheet.drawings;
  assert.match(pic.xml, /<xdr:pic>/);
  assert.deepEqual(Object.values(pic.rels).map((r) => [r.target, r.external]), [['xl/media/image1.png', false]]);
  assert.match(sp.xml, /Quarterly sales/);
  assert.deepEqual(pic.anchor.from, { col: 1, row: 18, dx: 0, dy: 0 });
  const box = anchorBox(sheet.rowSizes, sheet.colSizes, sp.anchor);
  assert.ok(Math.abs(box.x - (sheet.colSizes.position(5) + 12)) < 1e-6, 'a corner’s offset is in points');
});

test('a workbook saved with its drawings unchanged keeps its drawing part as it was', async () => {
  const { book } = await open();
  const written = await writeWorkbook(book);
  assert.equal(await drawingPart(written), await drawingPart(FIXTURE));
});

test('a drawing moved and sized gets new corners; the charts and the other drawing stay as they were', async () => {
  const { book, sheet, history } = await open();
  const edits = asIs(sheet);
  edits[1] = { ...edits[1], box: { x: sheet.colSizes.position(10), y: sheet.rowSizes.position(30), width: 100, height: 40 } };
  history.apply(0, { kind: 'drawings', edits });
  assert.deepEqual(sheet.drawings[1].anchor.from, { col: 10, row: 30, dx: 0, dy: 0 });
  const xml = await drawingPart(await writeWorkbook(book));
  const anchors = [...xml.matchAll(/<xdr:twoCellAnchor[\s\S]*?<\/xdr:twoCellAnchor>/g)].map((m) => m[0]);
  assert.equal(anchors.filter((a) => a.includes('<c:chart')).length, 7, 'every chart is kept');
  assert.match(anchors.find((a) => a.includes('Quarterly sales'))!, /<xdr:from><xdr:col>10<\/xdr:col><xdr:colOff>0<\/xdr:colOff><xdr:row>30<\/xdr:row>/);
  assert.match(anchors.find((a) => a.includes('<xdr:pic'))!, /<xdr:from><xdr:col>1<\/xdr:col><xdr:colOff>0<\/xdr:colOff><xdr:row>18<\/xdr:row>/);
  // Undone, it is back where it was.
  history.undo();
  assert.deepEqual(sheet.drawings[1].anchor.from.col, 5);
});

test('drawings follow their cells when rows are inserted above them', async () => {
  const { sheet, history } = await open();
  history.apply(0, { kind: 'insertRows', at: 2, count: 3 });
  assert.equal(sheet.drawings[0].anchor.from.row, 21);
  assert.equal(sheet.drawings[0].anchor.to!.row, 25);
});

test('a new picture becomes an image part with its relationship; one taken away takes its relationship with it', async () => {
  const { book, sheet, history } = await open();
  const png = new Uint8Array(FIXTURE.length ? [137, 80, 78, 71, 13, 10, 26, 10] : []);
  const shape = `<xdr:pic xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:nvPicPr><xdr:cNvPr id="0" name="Picture"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="new1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`;
  const edits: DrawingEdit[] = [
    asIs(sheet)[1],
    { shape, box: { x: 0, y: 0, width: 75, height: 75 }, rels: { new1: { type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target: 'media:1.png', external: false } } },
  ];
  history.apply(0, { kind: 'drawings', edits, media: [{ name: 'media:1.png', bytes: png.buffer }] });
  const pkg = await OpcPackage.read(await writeWorkbook(book));
  const rels = (await pkg.relationships('xl/drawings/drawing1.xml')).list;
  const images = rels.filter((r) => r.type.endsWith('/image'));
  assert.equal(images.length, 1, 'the old picture’s relationship went, the new one’s came');
  assert.equal(images[0].target, '../media/image2.png');
  assert.ok(pkg.has('xl/media/image2.png'));
  const xml = await pkg.text('xl/drawings/drawing1.xml');
  assert.match(xml, new RegExp(`r:embed="${images[0].id}"`));
  // Every shape has its own id.
  const ids = [...xml.matchAll(/cNvPr id="(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('a picture or shape below the cells in use is printed: the print area reaches it', async () => {
  const { book, sheet, history } = await open();
  const before = printLayout(book, sheet, 0, sheet.pageSetup).pages.at(-1)!.rows[1];
  const edits = asIs(sheet);
  edits[1] = { ...edits[1], box: { x: 0, y: sheet.rowSizes.position(400), width: 100, height: 40 } };
  history.apply(0, { kind: 'drawings', edits });
  const after = printLayout(book, sheet, 0, sheet.pageSetup).pages.at(-1)!.rows[1];
  assert.ok(before < 400 && after >= 400, `the last page ends at row ${after}`);
});

test('drawings’ colours turn with the cells’: flipped under Dark Pages, two colours under a contrast theme', () => {
  assert.equal(recolorFor(false, null), undefined);
  const dark = recolorFor(true, null)!;
  const white = darkPageColor(0xffffff);
  assert.deepEqual(dark([255, 255, 255, 0.5]), [(white >> 16) & 255, (white >> 8) & 255, white & 255, 0.5], 'the alpha is kept');
  const forced = recolorFor(true, { page: 0x000000, text: 0xffff00 })!;
  assert.deepEqual(forced([250, 250, 250, 1]), [0, 0, 0, 1]);
  assert.deepEqual(forced([20, 40, 200, 1]), [255, 255, 0, 1]);
});

test('a picture deleted leaves its image out of the saved file; undone, even after the save, it comes back with it', async () => {
  const { book, sheet, history } = await open();
  assert.ok((await OpcPackage.read(await writeWorkbook(book))).has('xl/media/image1.png'));
  history.apply(0, { kind: 'drawings', edits: [asIs(sheet)[1]] });
  const without = await OpcPackage.read(await writeWorkbook(book));
  assert.equal(without.has('xl/media/image1.png'), false, 'no relationship points at it any more');
  history.undo();
  const back = await OpcPackage.read(await writeWorkbook(book));
  assert.ok(back.has('xl/media/image1.png'));
  const rels = (await back.relationships('xl/drawings/drawing1.xml')).list.filter((r) => r.type.endsWith('/image'));
  assert.deepEqual(rels.map((r) => r.target), ['../media/image1.png']);
});

test('the drawings’ version changes when a row they are placed by is resized or hidden, so the page places them again', async () => {
  (globalThis as { self?: unknown }).self ??= globalThis;
  const { info } = await import('../src/sheet/worker.ts');
  const { book, history } = await open();
  const version = () => info(book).sheets[0].drawings!.version;
  const before = version();
  assert.equal(version(), before, 'unchanged while nothing changes');
  history.apply(0, { kind: 'rowHeight', rows: [2], size: 60 });
  const resized = version();
  assert.notEqual(resized, before);
  history.apply(0, { kind: 'hideRows', rows: [3], hidden: true });
  assert.notEqual(version(), resized);
});

test('a protected sheet refuses changes to its pictures and shapes', async () => {
  const { sheet, history } = await open();
  history.apply(0, { kind: 'protect', on: true, password: '' });
  const edits = asIs(sheet);
  edits[1] = { ...edits[1], box: { ...edits[1].box, x: edits[1].box.x + 50 } };
  const before = sheet.drawings;
  assert.equal(history.apply(0, { kind: 'drawings', edits }).message, 'sheetProtected');
  assert.equal(sheet.drawings, before);
});

test('a CSV or TSV offers no pictures, shapes or text boxes (it can’t keep them), but a workbook does', async () => {
  const { FORMATS, formatAllows } = await import('../src/ui/formats.ts');
  for (const op of ['insertPicture', 'insertShape', 'insertTextBox'] as const) {
    assert.equal(formatAllows(FORMATS.xlsx, { kind: 'sheet', op }), true, `xlsx ${op}`);
    assert.equal(formatAllows(FORMATS.csv, { kind: 'sheet', op }), false, `csv ${op}`);
    assert.equal(formatAllows(FORMATS.tsv, { kind: 'sheet', op }), false, `tsv ${op}`);
  }
});
