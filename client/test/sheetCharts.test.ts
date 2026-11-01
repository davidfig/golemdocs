// Charts in workbooks (docs/spreadsheets.md, M6): read from a sheet's drawing and chart parts (ours, and Excel's own
// save of them), and laid out from the cells they name.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { History } from '../src/sheet/edit.ts';
import { Engine } from '../src/sheet/formula/engine.ts';
import type { Worksheet } from '../src/sheet/model/worksheet.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';
import { writeWorkbook } from '../src/sheet/xlsx/write.ts';
import { chartScene, niceScale } from '../src/sheet/charts/scene.ts';

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

test('nice scales: steps of 1, 2 or 5 times a power of ten', () => {
  assert.deepEqual(niceScale(0, 21, 5), { min: 0, max: 25, step: 5 });
  assert.deepEqual(niceScale(0, 0.87, 5), { min: 0, max: 1, step: 0.2 });
  assert.deepEqual(niceScale(-3, 48, 5), { min: -10, max: 50, step: 10 });
});
