// Charts in workbooks (docs/spreadsheets.md, M6): read from a sheet's drawing and chart parts (ours, and Excel's own
// save of them), and laid out from the cells they name.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { History } from '../src/sheet/edit.ts';
import { Engine } from '../src/sheet/formula/engine.ts';
import { Worksheet } from '../src/sheet/model/worksheet.ts';
import { Workbook } from '../src/sheet/model/workbook.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';
import { writeWorkbook } from '../src/sheet/xlsx/write.ts';
import { chartScene, niceScale } from '../src/sheet/charts/scene.ts';
import { sparklineScene } from '../src/sheet/charts/sparklineScene.ts';
import { readChart } from '../src/sheet/charts/model.ts';
import { changeKind } from '../src/sheet/charts/make.ts';
import { syncChart } from '../src/sheet/charts/sync.ts';
import { OFFICE_THEME } from '../src/sheet/model/theme.ts';
import { parseXml, serializeXml } from '@golemdocs/docx';

const open = async (name: string) => {
  const book = await readWorkbook(readFileSync(new URL(`./fixtures/sheets/${name}`, import.meta.url)));
  const engine = new Engine(book);
  engine.recalculateAll();
  return { book, engine, sheet: book.sheets[0] as Worksheet };
};

for (const name of ['charts.xlsx', 'charts-excel.xlsx']) {
  test(`charts are read with their kind, series and place (${name})`, async () => {
    const { sheet } = await open(name);
    assert.deepEqual(
      sheet.charts.map((c) => [c.chart.title, c.chart.groups[0].kind, c.chart.groups[0].direction, c.chart.groups[0].grouping]),
      [
        ['Sales by month', 'bar', 'col', 'clustered'],
        ['Stacked', 'bar', 'bar', 'stacked'],
        ['Trend', 'line', 'col', 'standard'],
        ['North', 'pie', 'col', 'standard'],
        ['South', 'doughnut', 'col', 'standard'],
        ['Area', 'area', 'col', 'stacked'],
        ['North against South', 'scatter', 'col', 'standard'],
      ],
    );
    const first = sheet.charts[0];
    assert.deepEqual(first.chart.groups[0].series.map((s) => s.valRef), ['Sales!$B$2:$B$7', 'Sales!$C$2:$C$7', 'Sales!$D$2:$D$7']);
    assert.deepEqual([first.anchor.from.col, first.anchor.from.row, first.anchor.to?.col, first.anchor.to?.row], [5, 1, 12, 16]);
    assert.equal(sheet.charts[2].chart.groups[0].series[0].markers, true);
    assert.equal(sheet.charts[6].chart.groups[0].series[0].line, false, 'the scatter series has no line');
    assert.equal(sheet.charts[6].chart.legend, null);
  });
}

test('a chart is laid out from its cells as they are now, and follows an edit', async () => {
  const { book, engine, sheet } = await open('charts.xlsx');
  const scene = chartScene(book, engine, 0, sheet, sheet.charts[0], 'a');
  // The legend names the series from their header cells; the value axis runs 0 to 25 in fives.
  const texts = scene.texts.map((t) => t.text);
  assert.deepEqual(texts.slice(0, 4), ['Sales by month', 'North', 'South', 'West']);
  assert.deepEqual(texts.filter((t) => /^\d+$/.test(t)), ['0', '5', '10', '15', '20', '25']);
  assert.ok(texts.includes('Jan') && texts.includes('Jun'));
  assert.equal(scene.points.length / 2, scene.colors.length, 'a colour for every vertex');
  // A bigger value stretches the axis.
  new History(book).apply(0, { kind: 'input', range: { r0: 1, c0: 1, r1: 1, c1: 1 }, text: '90' });
  engine.recalculateAll();
  const after = chartScene(book, engine, 0, sheet, sheet.charts[0], 'a');
  assert.ok(after.texts.some((t) => t.text === '100'), 'the axis goes to 100');
});

test('charts are written back as they were', async () => {
  const { book } = await open('charts.xlsx');
  new History(book).apply(0, { kind: 'input', range: { r0: 1, c0: 1, r1: 1, c1: 1 }, text: '13' });
  const back = await readWorkbook(await writeWorkbook(book));
  assert.equal((back.sheets[0] as Worksheet).charts.length, 7);
});

test('charts follow inserted rows and a renamed sheet, in the model and in the file, and undo puts them back', async () => {
  const { book, sheet } = await open('charts.xlsx');
  const history = new History(book);
  history.apply(0, { kind: 'insertRows', at: 0, count: 2 });
  assert.equal(sheet.charts[0].chart.groups[0].series[0].valRef, 'Sales!$B$4:$B$9');
  assert.deepEqual([sheet.charts[0].anchor.from.row, sheet.charts[0].anchor.to?.row], [3, 18]);
  history.apply(0, { kind: 'renameSheet', sheet: 0, name: 'Totals' });
  assert.equal(sheet.charts[0].chart.groups[0].series[0].valRef, 'Totals!$B$4:$B$9');
  const back = (await readWorkbook(await writeWorkbook(book))).sheets[0] as Worksheet;
  assert.equal(back.charts[0].chart.groups[0].series[0].valRef, 'Totals!$B$4:$B$9');
  assert.equal(back.charts[0].chart.groups[0].series[0].catRef, 'Totals!$A$4:$A$9');
  assert.deepEqual([back.charts[0].anchor.from.row, back.charts[0].anchor.to?.row], [3, 18]);
  history.undo();
  history.undo();
  assert.equal(sheet.charts[0].chart.groups[0].series[0].valRef, 'Sales!$B$2:$B$7');
  assert.equal(sheet.charts[0].anchor.from.row, 1);
  sheet.dirty.layout = true;
  const again = (await readWorkbook(await writeWorkbook(book))).sheets[0] as Worksheet;
  assert.equal(again.charts[0].chart.groups[0].series[0].valRef, 'Sales!$B$2:$B$7', 'written back again after the undo');
  assert.equal(again.charts[0].anchor.from.row, 1);
});

test('Insert Chart makes a chart of a block; it is written with a drawing of its own, changed, and taken away', async () => {
  const book = new Workbook();
  const sheet = new Worksheet('Data', 1);
  book.sheets.push(sheet);
  const history = new History(book);
  history.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['Fruit', 'Kg', 'Price'], ['fig', '3', '2.5'], ['pear', '5', '1.2']] });
  history.apply(0, { kind: 'insertChart', chart: 'column', range: { r0: 1, c0: 1, r1: 1, c1: 1 } });
  const made = sheet.charts[0];
  assert.deepEqual(made.chart.groups[0].series.map((s) => [s.name, s.nameRef, s.catRef, s.valRef]), [
    ['Kg', 'Data!$B$1', 'Data!$A$2:$A$3', 'Data!$B$2:$B$3'],
    ['Price', 'Data!$C$1', 'Data!$A$2:$A$3', 'Data!$C$2:$C$3'],
  ]);
  assert.deepEqual([made.anchor.from.col, made.anchor.from.row], [4, 0], 'beside the block');
  assert.equal(history.apply(0, { kind: 'insertChart', chart: 'pie', range: { r0: 9, c0: 9, r1: 9, c1: 9 } }).message, 'noChartData');
  let back = (await readWorkbook(await writeWorkbook(book))).sheets[0] as Worksheet;
  assert.deepEqual(back.charts.map((c) => [c.chart.groups[0].kind, c.chart.groups[0].series.length, c.chart.title, c.chart.legend]), [['bar', 2, 'Chart Title', 'b']]);
  // Another kind, a title, no legend: written from the model.
  history.apply(0, { kind: 'chart', index: 0, change: { kind: 'line', title: 'Fruit', legend: null } });
  back = (await readWorkbook(await writeWorkbook(book))).sheets[0] as Worksheet;
  assert.deepEqual(back.charts.map((c) => [c.chart.groups[0].kind, c.chart.title, c.chart.legend]), [['line', 'Fruit', null]]);
  // A second chart on the same drawing, then the first taken away: its part goes, the second stays.
  history.apply(0, { kind: 'insertChart', chart: 'pie', range: { r0: 0, c0: 0, r1: 2, c1: 1 } });
  history.apply(0, { kind: 'chart', index: 0, change: { remove: true } });
  const written = await readWorkbook(await writeWorkbook(book));
  back = written.sheets[0] as Worksheet;
  assert.deepEqual(back.charts.map((c) => [c.chart.groups[0].kind, c.chart.title]), [['pie', 'Kg']]);
  assert.equal(written.source!.pkg.partNames.filter((n) => n.startsWith('xl/charts/')).length, 1, 'the removed chart’s part is gone');
  history.undo();
  assert.equal(sheet.charts.length, 2, 'undo brings it back');
  // Several charts made at once each get a part of their own.
  for (const chart of ['bar', 'area', 'scatter'] as const) history.apply(0, { kind: 'insertChart', chart, range: { r0: 0, c0: 0, r1: 0, c1: 0 } });
  const many = await readWorkbook(await writeWorkbook(book));
  assert.deepEqual((many.sheets[0] as Worksheet).charts.map((c) => c.chart.groups[0].kind), ['line', 'pie', 'bar', 'area', 'scatter']);
});

/** A chart part with the formatting Excel writes: a title's font, series fills and lines, data labels, an axis's text. */
const STYLED = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart>
<c:title><c:tx><c:rich><a:bodyPr rot="0"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1600" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="1600" b="1"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:rPr><a:t>Old</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>
<c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>
<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sales!$B$1</c:f></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="7030A0"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></c:spPr><c:invertIfNegative val="0"/><c:dLbls><c:dLblPos val="outEnd"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls><c:cat><c:strRef><c:f>Sales!$A$2:$A$7</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Sales!$B$2:$B$7</c:f></c:numRef></c:val><c:shape val="box"/></c:ser>
<c:gapWidth val="80"/><c:axId val="11"/><c:axId val="12"/></c:barChart>
<c:catAx><c:axId val="11"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900" i="1"/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr><c:crossAx val="12"/></c:catAx>
<c:valAx><c:axId val="12"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="11"/></c:valAx></c:plotArea>
<c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`;

test('a chart read from a file is changed in place: its title, legend and kind, its formatting kept', () => {
  const theme = OFFICE_THEME.colors;
  const xml = () => parseXml(STYLED);
  const model = readChart(xml(), theme)!;
  // Nothing changed: nothing is touched.
  assert.equal(syncChart(xml(), model, theme), false);
  // A new title keeps the old title's font and colour.
  let root = xml();
  assert.equal(syncChart(root, { ...model, title: 'New title' }, theme), true);
  let text = serializeXml(root);
  assert.match(text, /<a:rPr lang="en-US" sz="1600" b="1"><a:solidFill><a:srgbClr val="C00000"\/><\/a:solidFill><\/a:rPr><a:t>New title<\/a:t>/);
  assert.equal(readChart(root, theme)!.title, 'New title');
  // No title, then the legend at the bottom, then no legend.
  root = xml();
  syncChart(root, { ...model, title: null, legend: 'b' }, theme);
  assert.deepEqual([readChart(root, theme)!.title, readChart(root, theme)!.legend], [null, 'b']);
  assert.match(serializeXml(root), /<c:autoTitleDeleted val="1"\/>/);
  syncChart(root, { ...model, title: null, legend: null }, theme);
  assert.equal(readChart(root, theme)!.legend, null);
  // Columns made a line: the series keeps its colours and labels (not their bar-only position), the axes their text.
  root = xml();
  const line = changeKind({ anchor: { from: { row: 0, col: 0, dx: 0, dy: 0 } }, chart: model, part: 'x', rId: 'r', drawingPart: 'd' }, 'line').chart;
  syncChart(root, line, theme);
  text = serializeXml(root);
  assert.equal(readChart(root, theme)!.groups[0].kind, 'line');
  assert.match(text, /<c:lineChart>.*<c:spPr><a:ln w="12700"><a:solidFill><a:srgbClr val="7030A0"\/><\/a:solidFill><\/a:ln><\/c:spPr>/s, 'the bars’ colour is the line’s');
  assert.match(text, /<c:dLbls><c:showLegendKey val="0"\/>/, 'the labels stay, without their position');
  assert.doesNotMatch(text, /invertIfNegative|<c:shape |gapWidth|barDir/);
  assert.match(text, /<c:defRPr sz="900" i="1"\/>|<a:defRPr sz="900" i="1"\/>/, 'the category axis keeps its text');
  assert.match(text, /<c:axId val="11"\/><c:axId val="12"\/><\/c:lineChart>/);
  // Made a pie: no axes; then columns again: axes made anew.
  const pie = changeKind({ anchor: { from: { row: 0, col: 0, dx: 0, dy: 0 } }, chart: model, part: 'x', rId: 'r', drawingPart: 'd' }, 'pie').chart;
  root = xml();
  syncChart(root, pie, theme);
  assert.equal(readChart(root, theme)!.groups[0].kind, 'pie');
  assert.doesNotMatch(serializeXml(root), /catAx|valAx|axId/);
  syncChart(root, model, theme);
  assert.equal(readChart(root, theme)!.groups[0].kind, 'bar');
  assert.match(serializeXml(root), /<c:catAx>.*<c:valAx>/s);
});

test('Select Data: series named, added and taken away, categories changed, in the model and in Excel’s part', async () => {
  const { book, sheet } = await open('charts-excel.xlsx');
  const history = new History(book);
  const data = {
    series: [
      { name: '=Sales!$D$1', values: '=Sales!$D$2:$D$7' },
      { name: 'Typed name', values: 'B2:B7' },
    ],
    categories: '=Sales!$A$2:$A$7',
  };
  history.apply(0, { kind: 'chart', index: 0, change: { data } });
  assert.deepEqual(sheet.charts[0].chart.groups[0].series.map((s) => [s.name, s.nameRef, s.valRef, s.catRef]), [
    ['North', 'Sales!$D$1', 'Sales!$D$2:$D$7', 'Sales!$A$2:$A$7'],
    ['Typed name', null, 'Sales!B2:B7', 'Sales!$A$2:$A$7'],
  ]);
  assert.equal(history.apply(0, { kind: 'chart', index: 0, change: { data: { ...data, categories: 'not cells' } } }).message, 'badChartData');
  // A third series, added: it gets a part of the series list in the file.
  history.apply(0, { kind: 'chart', index: 0, change: { data: { ...data, series: [...data.series, { name: '=Sales!$C$1', values: '=Sales!$C$2:$C$7' }] } } });
  const written = await readWorkbook(await writeWorkbook(book));
  const back = (written.sheets[0] as Worksheet).charts[0].chart.groups[0].series;
  assert.deepEqual(back.map((s) => [s.nameRef, s.valRef]), [
    ['Sales!$D$1', 'Sales!$D$2:$D$7'],
    [null, 'Sales!B2:B7'],
    ['Sales!$C$1', 'Sales!$C$2:$C$7'],
  ]);
  // The legend names them from their cells (a reference's name is read from the cell, not a cache).
  const engine = new Engine(written);
  engine.recalculateAll();
  const legend = chartScene(written, engine, 0, written.sheets[0] as Worksheet, (written.sheets[0] as Worksheet).charts[0], 'x').texts.map((t) => t.text);
  assert.ok(['West', 'Typed name', 'South'].every((n) => legend.includes(n)));
  const xml = await written.source!.pkg.text('xl/charts/chart1.xml');
  assert.equal(xml.match(/<c:ser>/g)?.length, 3);
  assert.match(xml, /<c:tx><c:v>Typed name<\/c:v><\/c:tx>/);
});

for (const name of ['sparklines.xlsx', 'sparklines-excel.xlsx']) {
  test(`sparklines are read, drawn in their cells, follow inserted rows, and are written back (${name})`, async () => {
    const { book, engine, sheet } = await open(name);
    // Excel writes the groups in the other order: by kind here.
    const order = ['line', 'column', 'stacked'];
    sheet.sparklines.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    assert.deepEqual(sheet.sparklines.map((g) => [g.kind, g.markers, g.sparklines.map((s) => `${s.row},${s.col} ${s.ref}`)]), [
      ['line', true, ['1,7 Data!B2:G2', '2,7 Data!B3:G3', '3,7 Data!B4:G4']],
      ['column', false, ['1,8 Data!B2:G2', '2,8 Data!B3:G3', '3,8 Data!B4:G4']],
      ['stacked', false, ['1,9 Data!B2:G2', '2,9 Data!B3:G3', '3,9 Data!B4:G4']],
    ]);
    const scene = sparklineScene(book, engine, 0, sheet)!;
    assert.ok(scene.points.length > 0);
    // Every vertex is inside a sparkline's cell (columns H to J, rows 2 to 4).
    const left = sheet.colSizes.position(7);
    const right = sheet.colSizes.position(10);
    const top = sheet.rowSizes.position(1);
    const bottom = sheet.rowSizes.position(4);
    for (let i = 0; i < scene.points.length; i += 2) {
      assert.ok(scene.points[i] >= left - 3 && scene.points[i] <= right + 3 && scene.points[i + 1] >= top - 3 && scene.points[i + 1] <= bottom + 3);
    }
    const history = new History(book);
    history.apply(0, { kind: 'insertRows', at: 2, count: 1 });
    assert.deepEqual(sheet.sparklines[0].sparklines.map((s) => `${s.row} ${s.ref}`), ['1 Data!B2:G2', '3 Data!B4:G4', '4 Data!B5:G5']);
    const back = (await readWorkbook(await writeWorkbook(book))).sheets[0] as Worksheet;
    const stacked = back.sparklines.find((g) => g.kind === 'stacked')!;
    assert.deepEqual(stacked.sparklines.map((s) => `${s.row} ${s.ref}`), ['1 Data!B2:G2', '3 Data!B4:G4', '4 Data!B5:G5']);
    history.undo();
    assert.equal(sheet.sparklines[0].sparklines[2].row, 3);
  });
}

test('Insert › Sparklines puts one per row after the block; a sheet with none gets the extension; Clear takes them away', async () => {
  const book = new Workbook();
  const sheet = new Worksheet('Data', 1);
  book.sheets.push(sheet);
  const history = new History(book);
  history.apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['1', '3', '2'], ['4', '1', '5']] });
  history.apply(0, { kind: 'insertSparklines', sparkline: 'column', range: { r0: 0, c0: 0, r1: 1, c1: 2 } });
  assert.deepEqual(sheet.sparklines[0].sparklines, [
    { row: 0, col: 3, ref: 'Data!A1:C1' },
    { row: 1, col: 3, ref: 'Data!A2:C2' },
  ]);
  let back = (await readWorkbook(await writeWorkbook(book))).sheets[0] as Worksheet;
  assert.deepEqual(back.sparklines.map((g) => [g.kind, g.sparklines.length]), [['column', 2]]);
  // Line sparklines in the same cells take their place.
  history.apply(0, { kind: 'insertSparklines', sparkline: 'line', range: { r0: 0, c0: 0, r1: 1, c1: 2 } });
  assert.deepEqual(sheet.sparklines.map((g) => [g.kind, g.sparklines.length]), [['line', 2]]);
  history.apply(0, { kind: 'clearSparklines', range: { r0: 0, c0: 3, r1: 0, c1: 3 } });
  back = (await readWorkbook(await writeWorkbook(book))).sheets[0] as Worksheet;
  assert.deepEqual(back.sparklines.map((g) => g.sparklines.map((s) => s.row)), [[1]]);
  history.undo();
  assert.equal(sheet.sparklines[0].sparklines.length, 2);
});

test('nice scales: steps of 1, 2 or 5 times a power of ten', () => {
  assert.deepEqual(niceScale(0, 21, 5), { min: 0, max: 25, step: 5 });
  assert.deepEqual(niceScale(0, 0.87, 5), { min: 0, max: 1, step: 0.2 });
  assert.deepEqual(niceScale(-3, 48, 5), { min: -10, max: 50, step: 10 });
});
