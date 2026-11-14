// Writes the big workbook the home page's spreadsheet clip opens (scripts/marketing/record-workbook.ts): five years of a shop's
// orders, a million rows by default, with formula columns, number formats, a colour scale and data bars, a filter, frozen
// headers, and beside the orders a monthly summary with two charts. The data is made up from a seeded random number, so
// every run writes the same file. It is a few tens of megabytes, so it is written to .cache/ (not committed), not kept.
//
//   tsx scripts/marketing/make-workbook.ts                     writes .cache/marketing/orders.xlsx
//   tsx scripts/marketing/make-workbook.ts --rows 50000 --out /tmp/orders.xlsx
//
// The .xlsx is written by hand here (the app's own writer, client/src/sheet/xlsx/write.ts, needs a Workbook model built
// first): a zip of a few XML parts, deflated with node:zlib, and nothing else.

import { createWriteStream, mkdirSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, crc32, createDeflateRaw, deflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};

export const DEFAULT_WORKBOOK = path.join(root, '.cache/marketing/orders.xlsx');

// --- A zip, written as it goes ------------------------------------------------------------

interface Entry {
  name: Buffer;
  crc: number;
  size: number;
  packed: number;
  offset: number;
}

class Zip {
  private entries: Entry[] = [];
  private offset = 0;
  private out: ReturnType<typeof createWriteStream>;

  constructor(file: string) {
    this.out = createWriteStream(file);
  }

  private async write(data: Buffer): Promise<void> {
    this.offset += data.length;
    if (!this.out.write(data)) await once(this.out, 'drain');
  }

  private local(entry: Entry): Buffer {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(8, 8); // deflate
    h.writeUInt32LE(0x00210000, 10); // 1980-01-01, so the bytes never depend on the clock
    h.writeUInt32LE(entry.crc >>> 0, 14);
    h.writeUInt32LE(entry.packed, 18);
    h.writeUInt32LE(entry.size, 22);
    h.writeUInt16LE(entry.name.length, 26);
    return h;
  }

  /** A small part, deflated in one go. */
  async add(name: string, text: string): Promise<void> {
    const data = Buffer.from(text);
    const packed = deflateRawSync(data, { level: constants.Z_BEST_COMPRESSION });
    const entry: Entry = { name: Buffer.from(name), crc: crc32(data), size: data.length, packed: packed.length, offset: this.offset };
    this.entries.push(entry);
    await this.write(Buffer.concat([this.local(entry), entry.name]));
    await this.write(packed);
  }

  /** A big part, made in pieces: deflated as they come, then written with its header once its size is known. */
  async addPieces(name: string, pieces: Iterable<string>): Promise<void> {
    const deflate = createDeflateRaw({ level: 6 });
    const chunks: Buffer[] = [];
    deflate.on('data', (c: Buffer) => chunks.push(c));
    const done = once(deflate, 'end');
    let crc = 0;
    let size = 0;
    for (const piece of pieces) {
      const data = Buffer.from(piece);
      crc = crc32(data, crc);
      size += data.length;
      if (!deflate.write(data)) await once(deflate, 'drain');
    }
    deflate.end();
    await done;
    const packed = Buffer.concat(chunks);
    if (size >= 2 ** 32) throw new Error(`${name} is too big for a zip without zip64`);
    const entry: Entry = { name: Buffer.from(name), crc, size, packed: packed.length, offset: this.offset };
    this.entries.push(entry);
    await this.write(Buffer.concat([this.local(entry), entry.name]));
    await this.write(packed);
  }

  async close(): Promise<void> {
    const start = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(8, 10);
      h.writeUInt32LE(0x00210000, 12);
      h.writeUInt32LE(e.crc >>> 0, 16);
      h.writeUInt32LE(e.packed, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([h, e.name]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    this.out.end();
    await once(this.out, 'finish');
  }
}

// --- The data ---------------------------------------------------------------------------

const REGIONS = ['North', 'South', 'East', 'West', 'Central'];
const STORES = ['Aberdeen', 'Boulder', 'Cambridge', 'Dayton', 'Eugene', 'Fresno', 'Galway', 'Hamilton', 'Ithaca', 'Juneau', 'Kingston', 'Lansing', 'Madison', 'Nashua', 'Oxford', 'Portland', 'Quincy', 'Reno', 'Salem', 'Tacoma', 'Utica', 'Ventura', 'Wichita', 'Yonkers'];
const PRODUCTS: [string, string, number][] = [
  ['Desk lamp', 'Home', 34],
  ['Bookshelf', 'Home', 129],
  ['Armchair', 'Home', 349],
  ['Rug, 2 × 3 m', 'Home', 189],
  ['Kettle', 'Kitchen', 29],
  ['Chef’s knife', 'Kitchen', 79],
  ['Cast iron pan', 'Kitchen', 54],
  ['Coffee grinder', 'Kitchen', 64],
  ['Notebook, A5', 'Office', 9],
  ['Fountain pen', 'Office', 42],
  ['Monitor stand', 'Office', 49],
  ['Office chair', 'Office', 279],
  ['Rain jacket', 'Outdoor', 119],
  ['Tent, 2 person', 'Outdoor', 239],
  ['Hiking boots', 'Outdoor', 159],
  ['Water bottle', 'Outdoor', 19],
  ['Headphones', 'Electronics', 199],
  ['USB-C charger', 'Electronics', 25],
  ['Keyboard', 'Electronics', 89],
  ['E-reader', 'Electronics', 139],
];
const CATEGORIES = [...new Set(PRODUCTS.map((p) => p[1]))];
/** The category each month sells more of: kitchens and homes at the year's end, offices in September, the outdoors in summer. */
const SEASONS: (string | undefined)[] = ['Home', undefined, undefined, 'Outdoor', 'Outdoor', 'Outdoor', 'Outdoor', 'Office', 'Office', undefined, 'Kitchen', 'Kitchen'];
const STATUSES = ['Delivered', 'Delivered', 'Delivered', 'Delivered', 'Shipped', 'Shipped', 'Pending', 'Returned'];
/** 2021-01-01 as an Excel date serial; the orders run over five years from it. */
const FIRST_DAY = 44197;
const DAYS = 1826;
const MONTHS = 60;
const WEEKS = Math.ceil(DAYS / 7);

function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The month (0 to 59) of a date serial in 2021 to 2025. */
function monthOf(serial: number): number {
  const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
  return (d.getUTCFullYear() - 2021) * 12 + d.getUTCMonth();
}

interface Orders {
  count: number;
  date: Uint32Array;
  region: Uint8Array;
  store: Uint8Array;
  product: Uint8Array;
  units: Uint16Array;
  discount: Uint8Array;
  costRatio: Float32Array;
  status: Uint8Array;
}

function makeOrders(count: number): Orders {
  const rnd = random(20210101);
  const o: Orders = {
    count,
    date: new Uint32Array(count),
    region: new Uint8Array(count),
    store: new Uint8Array(count),
    product: new Uint8Array(count),
    units: new Uint16Array(count),
    discount: new Uint8Array(count),
    costRatio: new Float32Array(count),
    status: new Uint8Array(count),
  };
  for (let i = 0; i < count; i++) {
    // The shop grows: three times as many orders a day at the end as at the start.
    o.date[i] = FIRST_DAY + Math.min(DAYS - 1, Math.floor(((Math.sqrt(1 + 8 * (i / count)) - 1) / 2) * DAYS));
    o.region[i] = Math.floor(rnd() * REGIONS.length);
    // Some stores are busier than others.
    o.store[i] = Math.floor(rnd() ** 1.5 * STORES.length);
    // Some products sell far more than others, and each category has its season.
    const season = SEASONS[monthOf(o.date[i]) % 12];
    o.product[i] = season !== undefined && rnd() < 0.55 ? PRODUCTS.findIndex((p) => p[1] === season) + Math.floor(rnd() * 4) : Math.floor(rnd() ** 1.6 * PRODUCTS.length);
    o.units[i] = 1 + Math.floor(rnd() ** 3 * 24);
    o.discount[i] = rnd() < 0.7 ? 0 : [5, 10, 15, 20, 25][Math.floor(rnd() * 5)];
    o.costRatio[i] = 0.45 + rnd() * 0.4;
    o.status[i] = Math.floor(rnd() * STATUSES.length);
  }
  return o;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

// --- The parts ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument';

function column(n: number): string {
  let s = '';
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** The shared strings: every name the cells use, each once. */
const strings: string[] = [];
const stringIndex = new Map<string, number>();
const str = (s: string): number => {
  let i = stringIndex.get(s);
  if (i === undefined) {
    i = strings.length;
    strings.push(s);
    stringIndex.set(s, i);
  }
  return i;
};

/** Cell styles (cellXfs), by name. */
const S = { plain: 0, head: 1, order: 2, date: 3, int: 4, money: 5, pct: 6, pct1: 7, sumHead: 8, title: 9, month: 10, sumMoney: 11, totalMoney: 12, week: 13 };

const STYLES = `${XML}<styleSheet xmlns="${MAIN}">
<numFmts count="5"><numFmt numFmtId="164" formatCode="&quot;SO-&quot;0000000"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/><numFmt numFmtId="166" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="167" formatCode="mmm yyyy"/><numFmt numFmtId="168" formatCode="d/m"/></numFmts>
<fonts count="4"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><sz val="14"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2F5496"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF2F5496"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF2F5496"/></top><bottom style="double"><color rgb="FF2F5496"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="14">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="2" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="168" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;

const THEME = `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

/** The ledger's columns: A to N. */
const HEADS = ['Order', 'Date', 'Region', 'Store', 'Product', 'Category', 'Units', 'Unit price', 'Discount', 'Revenue', 'Cost', 'Profit', 'Margin', 'Status'];
const WIDTHS = [12, 11, 9, 11, 15, 11, 7, 10, 9, 11, 11, 11, 8, 10];
/** The summary sits from column P, a column after the ledger: month, the five regions, a total. */
const SUM_COL = 15;
/** The charts sit to the right of the summary, from column X. */
const CHART_COL = 23;
/** Then the weekly units of each product in each store, a row each, as a heat map: store, product, then a column a week. */
const HEAT_COL = CHART_COL + 14;
const HEAT_ROWS = STORES.length * PRODUCTS.length;
const LAST_COL = HEAT_COL + 2 + WEEKS - 1;

function* sheetXml(o: Orders, monthly: number[][], byCategory: number[], weekly: Uint16Array): Generator<string> {
  const last = o.count + 1;
  yield `${XML}<worksheet xmlns="${MAIN}" xmlns:r="${R}"><dimension ref="A1:${column(LAST_COL)}${Math.max(last, HEAT_ROWS + 2)}"/>`;
  yield `<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="J2" sqref="J2"/></sheetView></sheetViews>`;
  yield `<sheetFormatPr defaultRowHeight="15"/><cols>`;
  for (const [i, w] of WIDTHS.entries()) yield `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
  yield `<col min="${SUM_COL + 1}" max="${SUM_COL + 1}" width="10" customWidth="1"/><col min="${SUM_COL + 2}" max="${SUM_COL + 7}" width="11" customWidth="1"/>`;
  yield `<col min="${HEAT_COL + 1}" max="${HEAT_COL + 1}" width="11" customWidth="1"/><col min="${HEAT_COL + 2}" max="${HEAT_COL + 2}" width="15" customWidth="1"/><col min="${HEAT_COL + 3}" max="${LAST_COL + 1}" width="5.5" customWidth="1"/>`;
  yield `</cols><sheetData>`;

  const sumHeads = ['Month', ...REGIONS, 'Total'];
  const sumRow = (r: number): string => {
    // Row 1 is the summary's title, row 2 its headers, rows 3 to 62 the months, row 63 the totals; then the categories.
    const at = (c: number) => `${column(SUM_COL + c)}${r}`;
    if (r === 1) return `<c r="${at(0)}" s="${S.title}" t="s"><v>${str('Revenue by month and region')}</v></c>`;
    if (r === 2) return sumHeads.map((h, c) => `<c r="${at(c)}" s="${S.sumHead}" t="s"><v>${str(h)}</v></c>`).join('');
    const m = r - 3;
    if (m >= 0 && m < MONTHS) {
      const first = FIRST_DAY + Math.round((Date.UTC(2021 + Math.floor(m / 12), m % 12, 1) - Date.UTC(2021, 0, 1)) / 86_400_000);
      let cells = `<c r="${at(0)}" s="${S.month}"><v>${first}</v></c>`;
      for (let g = 0; g < REGIONS.length; g++) cells += `<c r="${at(1 + g)}" s="${S.sumMoney}"><v>${Math.round(monthly[m][g])}</v></c>`;
      const total = monthly[m].reduce((a, b) => a + Math.round(b), 0);
      return cells + `<c r="${at(6)}" s="${S.sumMoney}"><f>SUM(${column(SUM_COL + 1)}${r}:${column(SUM_COL + 5)}${r})</f><v>${total}</v></c>`;
    }
    if (m === MONTHS) {
      let cells = `<c r="${at(0)}" s="${S.sumHead}" t="s"><v>${str('Total')}</v></c>`;
      for (let g = 0; g <= REGIONS.length; g++) {
        const col = column(SUM_COL + 1 + g);
        const total = g < REGIONS.length ? monthly.reduce((a, row) => a + Math.round(row[g]), 0) : monthly.reduce((a, row) => a + row.reduce((b, v) => b + Math.round(v), 0), 0);
        cells += `<c r="${at(1 + g)}" s="${S.totalMoney}"><f>SUM(${col}3:${col}${MONTHS + 2})</f><v>${total}</v></c>`;
      }
      return cells;
    }
    // The categories, under the months: a title, headers, one row each.
    const k = m - MONTHS - 3;
    if (k === 0) return `<c r="${at(0)}" s="${S.title}" t="s"><v>${str('Revenue by category')}</v></c>`;
    if (k === 1) return `<c r="${at(0)}" s="${S.sumHead}" t="s"><v>${str('Category')}</v></c><c r="${at(1)}" s="${S.sumHead}" t="s"><v>${str('Revenue')}</v></c><c r="${at(2)}" s="${S.sumHead}" t="s"><v>${str('Share')}</v></c>`;
    const c = k - 2;
    if (c >= 0 && c < CATEGORIES.length) {
      const all = byCategory.reduce((a, b) => a + Math.round(b), 0);
      const top = MONTHS + 3 + 3 + 2;
      return `<c r="${at(0)}" t="s"><v>${str(CATEGORIES[c])}</v></c><c r="${at(1)}" s="${S.sumMoney}"><v>${Math.round(byCategory[c])}</v></c><c r="${at(2)}" s="${S.pct1}"><f>${column(SUM_COL + 1)}${r}/SUM(${column(SUM_COL + 1)}$${top}:${column(SUM_COL + 1)}$${top + CATEGORIES.length - 1})</f><v>${Math.round(byCategory[c]) / all}</v></c>`;
    }
    return '';
  };

  const heatRow = (r: number): string => {
    const at = (c: number) => `${column(HEAT_COL + c)}${r}`;
    if (r === 1) return `<c r="${at(0)}" s="${S.title}" t="s"><v>${str('Units sold each week, by store and product')}</v></c>`;
    if (r === 2) {
      let cells = `<c r="${at(0)}" s="${S.sumHead}" t="s"><v>${str('Store')}</v></c><c r="${at(1)}" s="${S.sumHead}" t="s"><v>${str('Product')}</v></c>`;
      for (let w = 0; w < WEEKS; w++) cells += `<c r="${at(2 + w)}" s="${S.week}"><v>${FIRST_DAY + w * 7}</v></c>`;
      return cells;
    }
    const k = r - 3;
    if (k < 0 || k >= HEAT_ROWS) return '';
    const store = Math.floor(k / PRODUCTS.length);
    const product = k % PRODUCTS.length;
    let cells = `<c r="${at(0)}" t="s"><v>${str(STORES[store])}</v></c><c r="${at(1)}" t="s"><v>${str(PRODUCTS[product][0])}</v></c>`;
    for (let w = 0; w < WEEKS; w++) cells += `<c r="${at(2 + w)}"><v>${weekly[k * WEEKS + w]}</v></c>`;
    return cells;
  };

  yield `<row r="1">${HEADS.map((h, c) => `<c r="${column(c)}1" s="${S.head}" t="s"><v>${str(h)}</v></c>`).join('')}${sumRow(1)}${heatRow(1)}</row>`;
  let batch = '';
  for (let i = 0; i < o.count; i++) {
    const r = i + 2;
    const [product, category, price] = PRODUCTS[o.product[i]];
    const units = o.units[i];
    const discount = o.discount[i] / 100;
    const revenue = units * price * (1 - discount);
    const cost = round2(units * price * o.costRatio[i]);
    const profit = revenue - cost;
    // The formula columns are shared formulas, written once on the first row (as Excel writes them), with their values.
    const f = (si: number, text: string) => (i === 0 ? `<f t="shared" ref="${column(9 + si)}2:${column(9 + si)}${last}" si="${si}">${text}</f>` : `<f t="shared" si="${si}"/>`);
    batch +=
      `<row r="${r}">` +
      `<c r="A${r}" s="${S.order}"><v>${100_000 + i}</v></c>` +
      `<c r="B${r}" s="${S.date}"><v>${o.date[i]}</v></c>` +
      `<c r="C${r}" t="s"><v>${str(REGIONS[o.region[i]])}</v></c>` +
      `<c r="D${r}" t="s"><v>${str(STORES[o.store[i]])}</v></c>` +
      `<c r="E${r}" t="s"><v>${str(product)}</v></c>` +
      `<c r="F${r}" t="s"><v>${str(category)}</v></c>` +
      `<c r="G${r}" s="${S.int}"><v>${units}</v></c>` +
      `<c r="H${r}" s="${S.money}"><v>${price}</v></c>` +
      `<c r="I${r}" s="${S.pct}"><v>${discount}</v></c>` +
      `<c r="J${r}" s="${S.money}">${f(0, `G${r}*H${r}*(1-I${r})`)}<v>${revenue}</v></c>` +
      `<c r="K${r}" s="${S.money}"><v>${cost}</v></c>` +
      `<c r="L${r}" s="${S.money}">${f(2, `J${r}-K${r}`)}<v>${round2(profit)}</v></c>` +
      `<c r="M${r}" s="${S.pct1}">${f(3, `IF(J${r}=0,0,L${r}/J${r})`)}<v>${revenue ? profit / revenue : 0}</v></c>` +
      `<c r="N${r}" t="s"><v>${str(STATUSES[o.status[i]])}</v></c>` +
      sumRow(r) +
      heatRow(r) +
      `</row>`;
    if (batch.length > 1 << 20) {
      yield batch;
      batch = '';
    }
  }
  yield batch;
  yield `</sheetData><autoFilter ref="A1:N${last}"/>`;
  // Units as data bars, the margin as a red to green colour scale, returns in red.
  yield `<conditionalFormatting sqref="G2:G${last}"><cfRule type="dataBar" priority="1"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar></cfRule></conditionalFormatting>`;
  yield `<conditionalFormatting sqref="M2:M${last}"><cfRule type="colorScale" priority="2"><colorScale><cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/><color rgb="FFF8696B"/><color rgb="FFFFEB84"/><color rgb="FF63BE7B"/></colorScale></cfRule></conditionalFormatting>`;
  yield `<conditionalFormatting sqref="${column(SUM_COL + 1)}3:${column(SUM_COL + 5)}${MONTHS + 2}"><cfRule type="colorScale" priority="3"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFFFFFFF"/><color rgb="FF5A8AC6"/></colorScale></cfRule></conditionalFormatting>`;
  yield `<conditionalFormatting sqref="${column(HEAT_COL + 2)}3:${column(LAST_COL)}${HEAT_ROWS + 2}"><cfRule type="colorScale" priority="4"><colorScale><cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/><color rgb="FFFCFCFF"/><color rgb="FFFFEB84"/><color rgb="FFF8696B"/></colorScale></cfRule></conditionalFormatting>`;
  yield `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><drawing r:id="rId1"/></worksheet>`;
}

function anchor(id: number, c0: number, r0: number, c1: number, r1: number, name: string): string {
  return `<xdr:twoCellAnchor><xdr:from><xdr:col>${c0}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${r0}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${c1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${r1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id + 1}" name="${name}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId${id}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
}

const DRAWING = `${XML}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}">${anchor(1, CHART_COL, 1, CHART_COL + 12, 30, 'Revenue by month')}${anchor(2, CHART_COL, 32, CHART_COL + 12, 62, 'Revenue by category')}</xdr:wsDr>`;

const ACCENTS = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '70AD47'];
const ref = (col: number, r0: number, r1: number) => `Orders!$${column(col)}$${r0}:$${column(col)}$${r1}`;
const axes = (bar: boolean) =>
  `<c:${bar ? 'catAx' : 'dateAx'}><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="${bar ? 'General' : 'mmm yyyy'}" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="2"/><c:crosses val="autoZero"/>${bar ? '<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>' : '<c:auto val="1"/><c:lblOffset val="100"/><c:baseTimeUnit val="months"/><c:majorUnit val="6"/><c:majorTimeUnit val="months"/>'}</c:${bar ? 'catAx' : 'dateAx'}>` +
  `<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="#,##0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="1"/><c:crosses val="autoZero"/><c:crossBetween val="${bar ? 'between' : 'midCat'}"/></c:valAx>`;

function chart(title: string, plot: string, legend: boolean): string {
  return `${XML}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}"><c:roundedCorners val="0"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${esc(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}</c:plotArea>${legend ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>' : ''}<c:plotVisOnly val="1"/></c:chart></c:chartSpace>`;
}

function lineChart(): string {
  const series = REGIONS.map(
    (_, g) =>
      `<c:ser><c:idx val="${g}"/><c:order val="${g}"/><c:tx><c:strRef><c:f>Orders!$${column(SUM_COL + 1 + g)}$2</c:f></c:strRef></c:tx><c:spPr><a:ln w="22225"><a:solidFill><a:srgbClr val="${ACCENTS[g]}"/></a:solidFill></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker><c:cat><c:numRef><c:f>${ref(SUM_COL, 3, MONTHS + 2)}</c:f></c:numRef></c:cat><c:val><c:numRef><c:f>${ref(SUM_COL + 1 + g, 3, MONTHS + 2)}</c:f></c:numRef></c:val><c:smooth val="0"/></c:ser>`,
  ).join('');
  return chart('Revenue by month', `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/><c:axId val="1"/><c:axId val="2"/></c:lineChart>${axes(false)}`, true);
}

function barChart(): string {
  const top = MONTHS + 3 + 3 + 2;
  const series = `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Orders!$${column(SUM_COL + 1)}$${top - 1}</c:f></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/><c:cat><c:strRef><c:f>${ref(SUM_COL, top, top + CATEGORIES.length - 1)}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${ref(SUM_COL + 1, top, top + CATEGORIES.length - 1)}</c:f></c:numRef></c:val></c:ser>`;
  return chart('Revenue by category', `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="80"/><c:axId val="1"/><c:axId val="2"/></c:barChart>${axes(true)}`, false);
}

export async function makeWorkbook(out: string, rows: number): Promise<void> {
  mkdirSync(path.dirname(out), { recursive: true });
  const orders = makeOrders(rows);
  const monthly = Array.from({ length: MONTHS }, () => REGIONS.map(() => 0));
  const byCategory = CATEGORIES.map(() => 0);
  const weekly = new Uint16Array(HEAT_ROWS * WEEKS);
  for (let i = 0; i < rows; i++) {
    weekly[(orders.store[i] * PRODUCTS.length + orders.product[i]) * WEEKS + Math.floor((orders.date[i] - FIRST_DAY) / 7)] += orders.units[i];
    const [, category, price] = PRODUCTS[orders.product[i]];
    const revenue = orders.units[i] * price * (1 - orders.discount[i] / 100);
    monthly[monthOf(orders.date[i])][orders.region[i]] += revenue;
    byCategory[CATEGORIES.indexOf(category)] += revenue;
  }
  // The shared strings are known only once the sheet is written, so it goes into the zip before them.
  const zip = new Zip(out);
  await zip.add(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="${CT}.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CT}.spreadsheetml.worksheet+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="${CT}.theme+xml"/><Override PartName="/xl/styles.xml" ContentType="${CT}.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${CT}.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="${CT}.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="${CT}.drawingml.chart+xml"/><Override PartName="/xl/charts/chart2.xml" ContentType="${CT}.drawingml.chart+xml"/></Types>`,
  );
  await zip.add('_rels/.rels', `${XML}<Relationships xmlns="${PR}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  await zip.add(
    'xl/workbook.xml',
    `${XML}<workbook xmlns="${MAIN}" xmlns:r="${R}"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="16000"/></bookViews><sheets><sheet name="Orders" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Orders!$A$1:$N$${rows + 1}</definedName></definedNames><calcPr calcId="191029"/></workbook>`,
  );
  await zip.add('xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="${PR}"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/theme" Target="theme/theme1.xml"/><Relationship Id="rId3" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId4" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
  await zip.add('xl/theme/theme1.xml', THEME);
  await zip.add('xl/styles.xml', STYLES);
  await zip.addPieces('xl/worksheets/sheet1.xml', sheetXml(orders, monthly, byCategory, weekly));
  await zip.add('xl/worksheets/_rels/sheet1.xml.rels', `${XML}<Relationships xmlns="${PR}"><Relationship Id="rId1" Type="${R}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
  await zip.add('xl/drawings/drawing1.xml', DRAWING);
  await zip.add('xl/drawings/_rels/drawing1.xml.rels', `${XML}<Relationships xmlns="${PR}"><Relationship Id="rId1" Type="${R}/chart" Target="../charts/chart1.xml"/><Relationship Id="rId2" Type="${R}/chart" Target="../charts/chart2.xml"/></Relationships>`);
  await zip.add('xl/charts/chart1.xml', lineChart());
  await zip.add('xl/charts/chart2.xml', barChart());
  // Every string cell refers to one of these by index; the count is how many cells do (Excel's own bookkeeping), estimated.
  await zip.add('xl/sharedStrings.xml', `${XML}<sst xmlns="${MAIN}" count="${rows * 5 + strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`);
  await zip.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(arg('out', DEFAULT_WORKBOOK));
  const rows = Number(arg('rows', '1000000'));
  const started = Date.now();
  await makeWorkbook(out, rows);
  console.log(`${path.relative(process.cwd(), out)}: ${rows.toLocaleString('en-US')} orders, ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
