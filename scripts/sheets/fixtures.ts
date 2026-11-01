// Small workbooks the tests open, written by the app's own writer from a model built here (so they hold what the editor
// makes, not only what Excel writes). Run `pnpm tsx scripts/sheets/fixtures.ts` to write them again; check.ts has Excel
// open them.
//
// validation.xlsx: a Status column (B2:B20) that takes Open, Done or Blocked from a drop-down list, and a Score column
// (C2:C20) that takes whole numbers from 1 to 10.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { History } from '../../client/src/sheet/edit.ts';
import { Workbook } from '../../client/src/sheet/model/workbook.ts';
import { Worksheet } from '../../client/src/sheet/model/worksheet.ts';
import { writeWorkbook } from '../../client/src/sheet/xlsx/write.ts';
import { OpcPackage } from '../../docx/src/index.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const FIXTURES = path.join(ROOT, 'client/test/fixtures/sheets');

export async function validationWorkbook(): Promise<Uint8Array> {
  const book = new Workbook();
  const sheet = new Worksheet('Tasks', 1);
  book.sheets.push(sheet);
  new History(book).apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: [['Task', 'Status', 'Score'], ['Write', 'Open', '3'], ['Test', 'Done', '8']] });
  sheet.validations = [
    { ranges: [{ r0: 1, c0: 1, r1: 19, c1: 1 }], type: 'list', operator: 'between', formula1: '"Open,Done,Blocked"', allowBlank: true, dropDown: true, errorStyle: 'stop', showError: true },
    { ranges: [{ r0: 1, c0: 2, r1: 19, c1: 2 }], type: 'whole', operator: 'between', formula1: '1', formula2: '10', allowBlank: true, dropDown: true, errorStyle: 'stop', showError: true, error: 'A score is a whole number from 1 to 10.' },
  ];
  sheet.dirty.layout = true;
  return writeWorkbook(book);
}

const CHART_NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A chart part: a chart of `kind` over the Sales sheet's months (A2:A7) and regions (columns B to D). */
function chartXml(plot: string, title: string, legend = true): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace ${CHART_NS}><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}</c:plotArea>${legend ? '<c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend>' : ''}<c:plotVisOnly val="1"/></c:chart></c:chartSpace>`;
}

const ser = (i: number, col: string, extra = '', cat = true) =>
  `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:strRef><c:f>Sales!$${col}$1</c:f></c:strRef></c:tx>${extra}${cat ? `<c:cat><c:strRef><c:f>Sales!$A$2:$A$7</c:f></c:strRef></c:cat>` : `<c:xVal><c:numRef><c:f>Sales!$B$2:$B$7</c:f></c:numRef></c:xVal>`}<c:${cat ? 'val' : 'yVal'}><c:numRef><c:f>Sales!$${col}$2:$${col}$7</c:f></c:numRef></c:${cat ? 'val' : 'yVal'}></c:ser>`;
const axes = '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="1"/></c:valAx>';
const ids = '<c:axId val="1"/><c:axId val="2"/>';
const three = (extra = '') => ser(0, 'B', extra) + ser(1, 'C', extra) + ser(2, 'D', extra);

/** charts.xlsx: six months of sales by region (Sales!A1:D7), and a chart of each kind the editor draws. */
export async function chartsWorkbook(): Promise<Uint8Array> {
  const book = new Workbook();
  const sheet = new Worksheet('Sales', 1);
  book.sheets.push(sheet);
  new History(book).apply(0, {
    kind: 'paste',
    at: { row: 0, col: 0 },
    rows: [['Month', 'North', 'South', 'West'], ['Jan', '12', '8', '5'], ['Feb', '15', '9', '7'], ['Mar', '11', '12', '6'], ['Apr', '18', '10', '9'], ['May', '21', '14', '8'], ['Jun', '19', '16', '11']],
  });
  const pkg = await OpcPackage.read(await writeWorkbook(book));
  const charts = [
    chartXml(`<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${three()}<c:gapWidth val="150"/>${ids}</c:barChart>${axes}`, 'Sales by month'),
    chartXml(`<c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/><c:varyColors val="0"/>${three()}<c:gapWidth val="100"/><c:overlap val="100"/>${ids}</c:barChart>${axes}`, 'Stacked'),
    chartXml(`<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${three('<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>')}<c:marker val="1"/>${ids}</c:lineChart>${axes}`, 'Trend'),
    chartXml(`<c:pieChart><c:varyColors val="1"/>${ser(0, 'B')}<c:firstSliceAng val="0"/></c:pieChart>`, 'North'),
    chartXml(`<c:doughnutChart><c:varyColors val="1"/>${ser(0, 'C')}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`, 'South'),
    chartXml(`<c:areaChart><c:grouping val="stacked"/><c:varyColors val="0"/>${three()}${ids}</c:areaChart>${axes}`, 'Area'),
    chartXml(`<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${ser(0, 'C', '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>', false)}${ids}</c:scatterChart><c:valAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:valAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="1"/></c:valAx>`, 'North against South', false),
  ];
  const drawingRels = await pkg.relationships('xl/drawings/drawing1.xml');
  const anchors = charts.map((xml, i) => {
    const part = `xl/charts/chart${i + 1}.xml`;
    pkg.set(part, xml, 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml');
    const rId = drawingRels.add('http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart', part);
    // Two charts a row, each 7 columns by 15 rows, from F2.
    const col = 5 + (i % 2) * 8;
    const row = 1 + Math.floor(i / 2) * 16;
    return `<xdr:twoCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${col + 7}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 15}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rId}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  });
  pkg.set(
    'xl/drawings/drawing1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors.join('')}</xdr:wsDr>`,
    'application/vnd.openxmlformats-officedocument.drawing+xml',
  );
  const sheetRels = await pkg.relationships('xl/worksheets/sheet1.xml');
  const drawingId = sheetRels.add('http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing', 'xl/drawings/drawing1.xml');
  const sheetXml = await pkg.text('xl/worksheets/sheet1.xml');
  pkg.set('xl/worksheets/sheet1.xml', sheetXml.replace('</worksheet>', `<drawing r:id="${drawingId}"/></worksheet>`), 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');
  return pkg.write();
}

/** sparklines.xlsx: three rows of six values (Data!B2:G4, some below zero), each with a line (H), a column (I) and a
 * win/loss (J) sparkline. */
export async function sparklinesWorkbook(): Promise<Uint8Array> {
  const book = new Workbook();
  book.sheets.push(new Worksheet('Data', 1));
  new History(book).apply(0, {
    kind: 'paste',
    at: { row: 0, col: 0 },
    rows: [['Item', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Line', 'Column', 'Win/loss'], ['pens', '3', '5', '2', '8', '6', '9'], ['ink', '-2', '4', '-1', '3', '5', '-3'], ['caps', '7', '7', '6', '4', '3', '1']],
  });
  const pkg = await OpcPackage.read(await writeWorkbook(book));
  const colors = '<x14:colorSeries rgb="FF376092"/><x14:colorNegative rgb="FFD00000"/><x14:colorAxis rgb="FF000000"/><x14:colorMarkers rgb="FFD00000"/><x14:colorFirst rgb="FFD00000"/><x14:colorLast rgb="FFD00000"/><x14:colorHigh rgb="FF00B050"/><x14:colorLow rgb="FFFF0000"/>';
  const group = (attrs: string, col: string) =>
    `<x14:sparklineGroup ${attrs} displayEmptyCellsAs="gap">${colors}<x14:sparklines>${[2, 3, 4].map((r) => `<x14:sparkline><xm:f>Data!B${r}:G${r}</xm:f><xm:sqref>${col}${r}</xm:sqref></x14:sparkline>`).join('')}</x14:sparklines></x14:sparklineGroup>`;
  const ext = `<extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">${group('markers="1" high="1" low="1"', 'H')}${group('type="column" negative="1" high="1"', 'I')}${group('type="stacked" negative="1"', 'J')}</x14:sparklineGroups></ext></extLst>`;
  const sheetXml = await pkg.text('xl/worksheets/sheet1.xml');
  pkg.set('xl/worksheets/sheet1.xml', sheetXml.replace('</worksheet>', `${ext}</worksheet>`), 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');
  return pkg.write();
}

/** The data pivots.xlsx summarises: twelve sales (Sales!A1:D13). */
export const PIVOT_SALES = [
  ['Region', 'Product', 'Month', 'Amount'],
  ['East', 'Pens', 'Jan', '120'],
  ['West', 'Ink', 'Jan', '80'],
  ['East', 'Ink', 'Feb', '45'],
  ['North', 'Pens', 'Feb', '200'],
  ['West', 'Pens', 'Mar', '60'],
  ['East', 'Paper', 'Mar', '30'],
  ['North', 'Ink', 'Mar', '75'],
  ['West', 'Paper', 'Apr', '90'],
  ['East', 'Pens', 'Apr', '150'],
  ['North', 'Paper', 'Apr', '40'],
  ['West', 'Ink', 'May', '55'],
  ['North', 'Pens', 'May', '110'],
];

/**
 * pivots.xlsx: Sales!A1:D13 and two pivot tables of it on the Pivot sheet, written with no records and refreshed when
 * they are opened (`refreshOnLoad`), so Excel lays them out itself: at A3, regions down and products across, the sum of
 * Amount; at H3, regions then products down, the sum and the average of Amount across. Excel's save of it (with
 * Excel's layout in the cells) is pivots-excel.xlsx.
 */
export async function pivotsWorkbook(): Promise<Uint8Array> {
  const book = new Workbook();
  book.sheets.push(new Worksheet('Sales', 1), new Worksheet('Pivot', 2));
  new History(book).apply(0, { kind: 'paste', at: { row: 0, col: 0 }, rows: PIVOT_SALES });
  const pkg = await OpcPackage.read(await writeWorkbook(book));
  const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  const distinct = (col: number) => [...new Set(PIVOT_SALES.slice(1).map((r) => r[col]))];
  const strings = (col: number) => `<sharedItems count="${distinct(col).length}">${distinct(col).map((v) => `<s v="${v}"/>`).join('')}</sharedItems>`;
  const amounts = PIVOT_SALES.slice(1).map((r) => +r[3]);
  const cacheXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotCacheDefinition xmlns="${MAIN}" xmlns:r="${REL}" refreshOnLoad="1" saveData="0" createdVersion="6" refreshedVersion="6" minRefreshableVersion="3" recordCount="0"><cacheSource type="worksheet"><worksheetSource ref="A1:D13" sheet="Sales"/></cacheSource><cacheFields count="4"><cacheField name="Region" numFmtId="0">${strings(0)}</cacheField><cacheField name="Product" numFmtId="0">${strings(1)}</cacheField><cacheField name="Month" numFmtId="0">${strings(2)}</cacheField><cacheField name="Amount" numFmtId="0"><sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1" containsInteger="1" minValue="${Math.min(...amounts)}" maxValue="${Math.max(...amounts)}"/></cacheField></cacheFields></pivotCacheDefinition>`;
  const workbookRels = await pkg.relationships('xl/workbook.xml');
  const cachePart = 'xl/pivotCache/pivotCacheDefinition1.xml';
  pkg.set(cachePart, cacheXml, `${TYPE}.pivotCacheDefinition+xml`);
  const cacheRel = workbookRels.add(`${REL}/pivotCacheDefinition`, cachePart);
  const workbookXml = await pkg.text('xl/workbook.xml');
  const pivotCaches = `<pivotCaches><pivotCache cacheId="1" r:id="${cacheRel}"/></pivotCaches>`;
  pkg.set('xl/workbook.xml', workbookXml.includes('<calcPr') ? workbookXml.replace(/(<calcPr[^>]*\/>)/, `$1${pivotCaches}`) : workbookXml.replace('</workbook>', `${pivotCaches}</workbook>`), `${TYPE}.sheet.main+xml`);
  const items = (col: number) => `<items count="${distinct(col).length + 1}">${distinct(col).map((_, i) => `<item x="${i}"/>`).join('')}<item t="default"/></items>`;
  const style = '<pivotTableStyleInfo name="PivotStyleLight16" showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0" showLastColumn="1"/>';
  const head = (name: string, ref: string) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotTableDefinition xmlns="${MAIN}" name="${name}" cacheId="1" applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0" applyPatternFormats="0" applyAlignmentFormats="0" applyWidthHeightFormats="1" dataCaption="Values" updatedVersion="6" minRefreshableVersion="3" useAutoFormatting="1" itemPrintTitles="1" createdVersion="6" indent="0" outline="1" outlineData="1" multipleFieldFilters="0"><location ref="${ref}" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"/>`;
  const pivots = [
    head('ByProduct', 'A3:E8') +
      `<pivotFields count="4"><pivotField axis="axisRow" showAll="0">${items(0)}</pivotField><pivotField axis="axisCol" showAll="0">${items(1)}</pivotField><pivotField showAll="0"/><pivotField dataField="1" showAll="0"/></pivotFields><rowFields count="1"><field x="0"/></rowFields><colFields count="1"><field x="1"/></colFields><dataFields count="1"><dataField name="Sum of Amount" fld="3" baseField="0" baseItem="0"/></dataFields>${style}</pivotTableDefinition>`,
    head('ByRegion', 'H3:J20') +
      `<pivotFields count="4"><pivotField axis="axisRow" showAll="0">${items(0)}</pivotField><pivotField axis="axisRow" showAll="0">${items(1)}</pivotField><pivotField showAll="0"/><pivotField dataField="1" showAll="0"/></pivotFields><rowFields count="2"><field x="0"/><field x="1"/></rowFields><colFields count="1"><field x="-2"/></colFields><dataFields count="2"><dataField name="Sum of Amount" fld="3" baseField="0" baseItem="0"/><dataField name="Average of Amount" fld="3" subtotal="average" baseField="0" baseItem="0"/></dataFields>${style}</pivotTableDefinition>`,
  ];
  const sheetRels = await pkg.relationships('xl/worksheets/sheet2.xml');
  pivots.forEach((xml, i) => {
    const part = `xl/pivotTables/pivotTable${i + 1}.xml`;
    pkg.set(part, xml, `${TYPE}.pivotTable+xml`);
    sheetRels.add(`${REL}/pivotTable`, part);
  });
  for (const i of [1, 2]) (await pkg.relationships(`xl/pivotTables/pivotTable${i}.xml`)).add(`${REL}/pivotCacheDefinition`, cachePart);
  return pkg.write();
}

if (import.meta.filename === path.resolve(process.argv[1] ?? '')) {
  writeFileSync(path.join(FIXTURES, 'pivots.xlsx'), await pivotsWorkbook());
  writeFileSync(path.join(FIXTURES, 'sparklines.xlsx'), await sparklinesWorkbook());
  writeFileSync(path.join(FIXTURES, 'validation.xlsx'), await validationWorkbook());
  writeFileSync(path.join(FIXTURES, 'charts.xlsx'), await chartsWorkbook());
  console.log('written');
}
