// Generates test workbooks for the spreadsheet work (docs/spreadsheets.md, M0): `.xlsx` files of any size, shaped like
// real data. Columns come in groups of ten, repeated to the width asked for:
//
//   id (integer) · amount (currency) · quantity · category (50 shared strings) · date · customer (many shared strings)
//   · flag (boolean) · total (=amount*quantity, a shared formula filled down) · ratio (some with exponents) · note (sparse)
//
// with a bold, filled header row. Files are written to .cache/sheets/ (ignored by git) and are not committed.
//
//   pnpm tsx scripts/sheets/generate.ts --rows 1000000 --cols 20
//   pnpm tsx scripts/sheets/generate.ts --rows 100000 --cols 200 --out wide.xlsx

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { columnName } from '../../client/src/sheet/model/column.ts';
import { STYLE, WORKSHEET_START, writeWorkbook } from './workbook.ts';

const { values } = parseArgs({ options: { rows: { type: 'string', default: '100000' }, cols: { type: 'string', default: '10' }, out: { type: 'string' }, seed: { type: 'string', default: '1' } } });
const ROWS = Number(values.rows);
const COLS = Number(values.cols);
const out = path.resolve(import.meta.dirname, '../../.cache/sheets', values.out ?? `sheet-${ROWS}x${COLS}.xlsx`);

/** A small seeded generator (mulberry32), so a file is the same every time. */
let seed = Number(values.seed) >>> 0;
function random(): number {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const HEADERS = ['id', 'amount', 'quantity', 'category', 'date', 'customer', 'flag', 'total', 'ratio', 'note'];
const CATEGORIES = Array.from({ length: 50 }, (_, i) => `Category ${columnName(i)}`);
const CUSTOMERS = Math.max(10, Math.floor(ROWS / 10));

// Shared strings: headers, then categories, then customers, then notes.
const strings: string[] = [];
const stringIds = new Map<string, number>();
function shared(text: string): number {
  let id = stringIds.get(text);
  if (id === undefined) stringIds.set(text, (id = strings.push(text) - 1));
  return id;
}


const encoder = new TextEncoder();
const parts: Uint8Array[] = [];
let pending = '';
const flush = (force = false) => {
  if (pending.length > 1 << 22 || (force && pending)) {
    parts.push(encoder.encode(pending));
    pending = '';
  }
};

const started = performance.now();
pending += WORKSHEET_START;
pending += `<dimension ref="A1:${columnName(COLS - 1)}${ROWS + 1}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
pending += `<sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="${COLS}" width="14" customWidth="1"/></cols><sheetData>`;

pending += `<row r="1">`;
for (let c = 0; c < COLS; c++) {
  const group = Math.floor(c / 10);
  const name = HEADERS[c % 10] + (group ? ` ${group + 1}` : '');
  pending += `<c r="${columnName(c)}1" s="${STYLE.header}" t="s"><v>${shared(name)}</v></c>`;
}
pending += `</row>`;

let rowAmount = 0;
let rowQuantity = 0;
const names = Array.from({ length: COLS }, (_, c) => columnName(c));
for (let r = 2; r <= ROWS + 1; r++) {
  pending += `<row r="${r}">`;
  for (let c = 0; c < COLS; c++) {
    const ref = names[c] + r;
    const group = c - (c % 10);
    let amount = 0;
    let quantity = 0;
    switch (c % 10) {
      case 0:
        pending += `<c r="${ref}"><v>${r - 1 + group * ROWS}</v></c>`;
        break;
      case 1:
        amount = Math.round(random() * 1_000_000) / 100;
        pending += `<c r="${ref}" s="${STYLE.currency}"><v>${amount}</v></c>`;
        break;
      case 2:
        quantity = 1 + Math.floor(random() * 100);
        pending += `<c r="${ref}"><v>${quantity}</v></c>`;
        break;
      case 3:
        pending += `<c r="${ref}" t="s"><v>${shared(CATEGORIES[Math.floor(random() * CATEGORIES.length)])}</v></c>`;
        break;
      case 4:
        pending += `<c r="${ref}" s="${STYLE.date}"><v>${44927 + Math.floor(random() * 1500)}</v></c>`;
        break;
      case 5:
        pending += `<c r="${ref}" t="s"><v>${shared(`Customer ${Math.floor(random() * CUSTOMERS)}`)}</v></c>`;
        break;
      case 6:
        pending += `<c r="${ref}" t="b"><v>${random() < 0.5 ? 1 : 0}</v></c>`;
        break;
      case 7: {
        // The cached value Excel would have saved: the amount and quantity of this row, read back from what was written.
        const total = rowAmount * rowQuantity;
        const formula = r === 2 ? `<f t="shared" ref="${ref}:${names[c]}${ROWS + 1}" si="${group / 10}">${names[group + 1]}2*${names[group + 2]}2</f>` : `<f t="shared" si="${group / 10}"/>`;
        pending += `<c r="${ref}" s="${STYLE.currency}">${formula}<v>${total}</v></c>`;
        break;
      }
      case 8: {
        const ratio = random() < 0.05 ? random() * 1e-9 : random();
        pending += `<c r="${ref}" s="${STYLE.percent}"><v>${ratio}</v></c>`;
        break;
      }
      case 9:
        if (r % 50 === 0) pending += `<c r="${ref}" t="s"><v>${shared(`Note for row ${r} & more`)}</v></c>`;
        break;
    }
    if (c % 10 === 1) rowAmount = amount;
    if (c % 10 === 2) rowQuantity = quantity;
  }
  pending += `</row>`;
  flush();
}
pending += `</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
flush(true);

const sheetBytes = parts.reduce((n, p) => n + p.length, 0);
const zip = await writeWorkbook({ sheets: [{ name: 'Data', xml: parts }], sharedStrings: strings });
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, zip);
const mb = (n: number) => (n / 1e6).toFixed(1) + ' MB';
console.log(`${out}\n  ${ROWS.toLocaleString()} rows x ${COLS} columns, ${strings.length.toLocaleString()} shared strings`);
console.log(`  sheet XML ${mb(sheetBytes)}, file ${mb(zip.length)}, ${((performance.now() - started) / 1000).toFixed(1)} s`);
