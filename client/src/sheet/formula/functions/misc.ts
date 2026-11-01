// The rest: text as Excel writes values (ARRAYTOTEXT, VALUETOTEXT), Thai baht in words, regular expressions, URLs and XML,
// what CELL and INFO say, PERCENTOF and TRIMRANGE, and the summarising GROUPBY and PIVOTBY.

import { parseXml, textContent } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import { columnName } from '../../model/column.ts';
import { numbers, toArray, trimmed } from '../runtime.ts';
import type { Context } from '../runtime.ts';
import { ArrayValue, BLANK, CALC, DIV0, FormulaError, LambdaValue, NA, RangeRef, VALUE, compare, isError, numberToText, toBool, toNumber, toText } from '../values.ts';
import type { Scalar, Value } from '../values.ts';
import { define } from './registry.ts';

const text = (v: Value | undefined): string | FormulaError => (v === undefined ? '' : toText(v as Scalar));
const int = (v: Value | undefined, fallback: number): number | FormulaError => {
  if (v === undefined || v === BLANK) return fallback;
  const n = toNumber(v as Scalar);
  return isError(n) ? n : Math.trunc(n);
};

/** A value as text, quoted in strict form ("abc" with quotes, numbers and logicals as they are). */
function valueText(v: Scalar, strict: boolean): string {
  if (typeof v === 'number') return numberToText(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v === BLANK) return '';
  if (v instanceof FormulaError) return v.name;
  return strict ? `"${v.replace(/"/g, '""')}"` : v;
}

define('VALUETOTEXT', 1, 2, ['value', 'value'], ([v, f]) => {
  const format = int(f, 0);
  if (isError(format)) return format;
  if (format !== 0 && format !== 1) return VALUE;
  return valueText(v as Scalar, format === 1);
});
define('ARRAYTOTEXT', 1, 2, ['array', 'value'], ([v, f], ctx) => {
  const a = toArray(v, ctx);
  if (isError(a)) return a;
  const format = int(f, 0);
  if (isError(format)) return format;
  if (format !== 0 && format !== 1) return VALUE;
  if (format === 0) return a.data.map((s) => valueText(s, false)).join(', ');
  const rows: string[] = [];
  for (let r = 0; r < a.rows; r++) rows.push(Array.from({ length: a.cols }, (_, c) => valueText(a.get(r, c), true)).join(','));
  return `{${rows.join(';')}}`;
});

// --- BAHTTEXT ---

const THAI_DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const THAI_PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

/** A whole number below a million in Thai words, as BAHTTEXT says it ("หนึ่ง" in the units after tens is "เอ็ด"). */
function thaiBelowMillion(n: number, more: boolean): string {
  const digits = String(n).split('').map(Number);
  let out = '';
  digits.forEach((d, i) => {
    const place = digits.length - 1 - i;
    if (d === 0) return;
    if (place === 1 && d === 1) out += 'สิบ';
    else if (place === 1 && d === 2) out += 'ยี่สิบ';
    else if (place === 0 && d === 1 && (digits.length > 1 || more)) out += 'เอ็ด';
    else out += THAI_DIGITS[d] + THAI_PLACES[place];
  });
  return out;
}

function thaiNumber(n: number): string {
  if (n === 0) return '';
  const millions = Math.floor(n / 1_000_000);
  const rest = n % 1_000_000;
  return (millions ? thaiNumber(millions) + 'ล้าน' : '') + thaiBelowMillion(rest, millions > 0);
}

define('BAHTTEXT', 1, 1, 'value', ([v]) => {
  const n = toNumber(v as Scalar);
  if (isError(n)) return n;
  const satangTotal = Math.round(Math.abs(n) * 100);
  const baht = Math.floor(satangTotal / 100);
  const satang = satangTotal % 100;
  let out = n < 0 ? 'ลบ' : '';
  if (baht) out += thaiNumber(baht) + 'บาท';
  if (satang) out += thaiNumber(satang) + 'สตางค์';
  else out += baht ? 'ถ้วน' : 'ศูนย์บาทถ้วน';
  return out;
});

define('PHONETIC', 1, 1, 'any', ([v], ctx) => {
  if (v instanceof RangeRef) {
    let out = '';
    ctx.host.forEach(trimmed(v, ctx), (s) => {
      if (typeof s === 'string') out += s;
    });
    return out;
  }
  return isError(v) ? v : typeof v === 'string' ? v : VALUE;
});

// --- Regular expressions ---

function regex(pattern: string, caseless: boolean, global: boolean): RegExp | FormulaError {
  try {
    return new RegExp(pattern, (caseless ? 'i' : '') + (global ? 'g' : '') + 'u');
  } catch {
    return VALUE;
  }
}

define('REGEXTEST', 2, 3, 'value', ([t, p, c]) => {
  const s = text(t);
  if (isError(s)) return s;
  const pattern = text(p);
  if (isError(pattern)) return pattern;
  const caseless = int(c, 0);
  if (isError(caseless)) return caseless;
  const re = regex(pattern, caseless === 1, false);
  return isError(re) ? re : re.test(s);
});
define('REGEXEXTRACT', 2, 4, 'value', ([t, p, m, c]) => {
  const s = text(t);
  if (isError(s)) return s;
  const pattern = text(p);
  if (isError(pattern)) return pattern;
  const mode = int(m, 0);
  if (isError(mode)) return mode;
  const caseless = int(c, 0);
  if (isError(caseless)) return caseless;
  const re = regex(pattern, caseless === 1, mode === 1);
  if (isError(re)) return re;
  if (mode === 1) {
    const all = [...s.matchAll(re)].map((x) => x[0]);
    return all.length ? new ArrayValue(1, all.length, all) : NA;
  }
  const match = re.exec(s);
  if (!match) return NA;
  if (mode === 2) {
    const groups = match.slice(1).map((g) => g ?? '');
    return groups.length ? new ArrayValue(1, groups.length, groups) : NA;
  }
  return match[0];
});
define('REGEXREPLACE', 3, 5, 'value', ([t, p, r, o, c]) => {
  const s = text(t);
  if (isError(s)) return s;
  const pattern = text(p);
  if (isError(pattern)) return pattern;
  const replacement = text(r);
  if (isError(replacement)) return replacement;
  const occurrence = int(o, 0);
  if (isError(occurrence)) return occurrence;
  const caseless = int(c, 0);
  if (isError(caseless)) return caseless;
  const re = regex(pattern, caseless === 1, true);
  if (isError(re)) return re;
  if (occurrence === 0) return s.replace(re, replacement);
  const matches = [...s.matchAll(re)];
  const target = occurrence > 0 ? matches[occurrence - 1] : matches[matches.length + occurrence];
  if (!target) return s;
  const one = new RegExp(re.source, re.flags.replace('g', ''));
  return s.slice(0, target.index) + target[0].replace(one, replacement) + s.slice(target.index! + target[0].length);
});

// --- Web ---

define('ENCODEURL', 1, 1, 'value', ([v]) => {
  const s = text(v);
  if (isError(s)) return s;
  return Array.from(new TextEncoder().encode(s), (b) => (/[A-Za-z0-9\-_.~]/.test(String.fromCharCode(b)) && b < 128 ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0'))).join('');
});

/** The nodes an XPath (a subset: /a/b, //b, *, [n], @attr, text()) picks from a document, as text. */
function xpath(root: XmlElement, path: string): string[] | null {
  const steps = path.match(/\/\/?[^/]+/g);
  if (!steps || steps.join('') !== path) return null;
  let nodes: (XmlElement | string)[] = [{ name: '#document', attrs: {}, children: [root] }];
  for (const step of steps) {
    const deep = step.startsWith('//');
    const body = step.slice(deep ? 2 : 1);
    const m = /^(@?[\w:.*-]+|text\(\))(?:\[(\d+)\])?$/.exec(body);
    if (!m) return null;
    const [, test, index] = m;
    const next: (XmlElement | string)[] = [];
    for (const node of nodes) {
      if (typeof node === 'string') continue;
      const pool = deep ? descendants(node) : [node];
      for (const p of pool) {
        if (test.startsWith('@')) {
          const value = p.attrs[test.slice(1)];
          if (value !== undefined) next.push(value);
        } else if (test === 'text()') {
          for (const c of p.children) if (typeof c === 'string') next.push(c);
        } else {
          const kids = p.children.filter((c): c is XmlElement => typeof c !== 'string' && (test === '*' || c.name === test));
          next.push(...(index ? kids.slice(+index - 1, +index) : kids));
        }
      }
    }
    nodes = next;
  }
  return nodes.map((n) => (typeof n === 'string' ? n : textContent(n)));
}
function descendants(e: XmlElement): XmlElement[] {
  const out: XmlElement[] = [e];
  for (const c of e.children) if (typeof c !== 'string') out.push(...descendants(c));
  return out;
}
define('FILTERXML', 2, 2, 'value', ([x, p]) => {
  const xml = text(x);
  if (isError(xml)) return xml;
  const path = text(p);
  if (isError(path)) return path;
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch {
    return VALUE;
  }
  const found = xpath(root, path);
  if (!found || !found.length) return VALUE;
  const values = found.map((s): Scalar => {
    const n = Number(s);
    return s.trim() !== '' && Number.isFinite(n) ? n : s;
  });
  return values.length === 1 ? values[0] : new ArrayValue(values.length, 1, values);
});

// --- CELL and INFO ---

define('CELL', 1, 2, ['value', 'any'], ([t, ref], ctx) => {
  const type = text(t);
  if (isError(type)) return type;
  const r = ref instanceof RangeRef ? ref : ref === undefined ? new RangeRef(ctx.sheet, ctx.row, ctx.col, ctx.row, ctx.col) : null;
  if (!r) return isError(ref) ? ref : VALUE;
  const value = ctx.host.value(r.sheet, r.r0, r.c0);
  switch (type.toLowerCase()) {
    case 'address':
      return (r.sheet !== ctx.sheet ? `'${ctx.host.sheetName(r.sheet)}'!` : '') + `$${columnName(r.c0)}$${r.r0 + 1}`;
    case 'col':
      return r.c0 + 1;
    case 'row':
      return r.r0 + 1;
    case 'contents':
      return value === BLANK ? 0 : value;
    case 'type':
      return value === BLANK ? 'b' : typeof value === 'string' ? 'l' : 'v';
    case 'sheetname':
      return ctx.host.sheetName(r.sheet);
    case 'filename':
      return '';
    case 'format':
      return 'G';
    case 'width':
      return 8;
    case 'prefix':
      return typeof value === 'string' ? "'" : '';
    case 'protect':
      return 1;
    case 'color':
    case 'parentheses':
      return 0;
    default:
      return VALUE;
  }
});
define('INFO', 1, 1, 'value', ([t], ctx) => {
  const type = text(t);
  if (isError(type)) return type;
  switch (type.toLowerCase()) {
    case 'directory':
      return '';
    case 'numfile':
      return ctx.host.sheetCount();
    case 'origin':
      return '$A:$A$1';
    case 'osversion':
      return 'Golem Docs';
    case 'recalc':
      return 'Automatic';
    case 'release':
      return '16.0';
    case 'system':
      return 'pcdos';
    default:
      return VALUE;
  }
});

// --- PERCENTOF and TRIMRANGE ---

define('PERCENTOF', 2, 2, 'any', ([a, b], ctx) => {
  const part = numbers([a], ctx);
  if (isError(part)) return part;
  const whole = numbers([b], ctx);
  if (isError(whole)) return whole;
  const total = whole.reduce((s, n) => s + n, 0);
  return total === 0 ? DIV0 : part.reduce((s, n) => s + n, 0) / total;
});

define('TRIMRANGE', 1, 3, ['any', 'value', 'value'], ([v, rt, ct], ctx) => {
  if (!(v instanceof RangeRef)) return isError(v) ? v : VALUE;
  const rows = int(rt, 3);
  if (isError(rows)) return rows;
  const cols = int(ct, 3);
  if (isError(cols)) return cols;
  // The smallest box holding every non-blank cell, trimmed at the ends asked (1 leading, 2 trailing, 3 both).
  let r0 = Infinity;
  let r1 = -1;
  let c0 = Infinity;
  let c1 = -1;
  ctx.host.forEach(trimmed(v, ctx), (_s, row, col) => {
    r0 = Math.min(r0, row);
    r1 = Math.max(r1, row);
    c0 = Math.min(c0, col);
    c1 = Math.max(c1, col);
  });
  if (r1 < 0) return CALC;
  return new RangeRef(v.sheet, rows & 1 ? r0 : v.r0, cols & 1 ? c0 : v.c0, rows & 2 ? r1 : v.r1, cols & 2 ? c1 : v.c1);
});

// --- GROUPBY and PIVOTBY ---

/** A grouping key's text (case does not matter, as in Excel). */
const keyOf = (row: Scalar[]): string => row.map((v) => (typeof v === 'string' ? 's' + v.toLowerCase() : v === BLANK ? 'b' : typeof v === 'object' ? 'e' + v.code : typeof v + String(v))).join('\u0000');

/** Applies a summarising function (a LAMBDA, or a function by name) to a column of values. */
function summarise(fn: LambdaValue, values: Scalar[]): Scalar {
  const out = fn.call([new ArrayValue(values.length, 1, values)]);
  if (out instanceof ArrayValue) return out.get(0, 0);
  if (out instanceof RangeRef || out instanceof LambdaValue) return VALUE;
  return out as Scalar;
}

interface Group {
  key: Scalar[];
  rows: number[];
}

/** Rows grouped by their keys, in first-seen order, then sorted ascending (or descending) by the keys. */
function group(keys: ArrayValue, rows: number[], order: number): Group[] {
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const key = Array.from({ length: keys.cols }, (_, c) => keys.get(r, c));
    const k = keyOf(key);
    const g = groups.get(k);
    if (g) g.rows.push(r);
    else groups.set(k, { key, rows: [r] });
  }
  const list = [...groups.values()];
  if (order) {
    list.sort((a, b) => {
      for (let i = 0; i < a.key.length; i++) {
        const c = compare(a.key[i], b.key[i]);
        if (c) return c * Math.sign(order);
      }
      return 0;
    });
  }
  return list;
}

/** The rows a filter array keeps. */
function kept(n: number, filter: Value | undefined, ctx: Context): number[] | FormulaError {
  if (filter === undefined || filter === BLANK) return Array.from({ length: n }, (_, i) => i);
  const f = toArray(filter, ctx);
  if (isError(f)) return f;
  if (f.data.length !== n) return VALUE;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const b = f.data[i] === BLANK ? false : toBool(f.data[i]);
    if (isError(b)) return b;
    if (b) out.push(i);
  }
  return out;
}

define('GROUPBY', 3, 8, ['array', 'array', 'any', 'value', 'value', 'value', 'array', 'value'], ([rf, vf, fn, headers, depth, sort, filter], ctx) => {
  const keys = toArray(rf, ctx);
  if (isError(keys)) return keys;
  const values = toArray(vf, ctx);
  if (isError(values)) return values;
  if (!(fn instanceof LambdaValue)) return isError(fn) ? fn : VALUE;
  if (keys.rows !== values.rows) return VALUE;
  const head = int(headers, 0);
  if (isError(head)) return head;
  const totals = int(depth, 1);
  if (isError(totals)) return totals;
  const order = int(sort, 1);
  if (isError(order)) return order;
  const skip = head === 1 || head === 3 ? 1 : 0;
  const rows = kept(keys.rows, filter, ctx);
  if (isError(rows)) return rows;
  const groups = group(keys, rows.filter((r) => r >= skip), order);
  const width = keys.cols + values.cols;
  const out: Scalar[][] = [];
  if (head === 3) out.push([...Array.from({ length: keys.cols }, (_, c) => keys.get(0, c)), ...Array.from({ length: values.cols }, (_, c) => values.get(0, c))]);
  for (const g of groups) out.push([...g.key, ...Array.from({ length: values.cols }, (_, c) => summarise(fn, g.rows.map((r) => values.get(r, c))))]);
  if (totals !== 0) {
    const all = rows.filter((r) => r >= skip);
    const total: Scalar[] = ['Total', ...Array<Scalar>(keys.cols - 1).fill(''), ...Array.from({ length: values.cols }, (_, c) => summarise(fn, all.map((r) => values.get(r, c))))];
    if (totals > 0) out.push(total);
    else out.splice(head === 3 ? 1 : 0, 0, total);
  }
  return out.length ? ArrayValue.of(out.map((r) => r.slice(0, width))) : CALC;
});

define('PIVOTBY', 4, 11, ['array', 'array', 'array', 'any', 'value', 'value', 'value', 'value', 'value', 'array', 'value'], ([rf, cf, vf, fn, headers, rDepth, rSort, cDepth, cSort, filter], ctx) => {
  const rowKeys = toArray(rf, ctx);
  if (isError(rowKeys)) return rowKeys;
  const colKeys = toArray(cf, ctx);
  if (isError(colKeys)) return colKeys;
  const values = toArray(vf, ctx);
  if (isError(values)) return values;
  if (!(fn instanceof LambdaValue)) return isError(fn) ? fn : VALUE;
  if (rowKeys.rows !== values.rows || colKeys.rows !== values.rows || values.cols !== 1) return VALUE;
  const head = int(headers, 0);
  const rowTotals = int(rDepth, 1);
  const rowOrder = int(rSort, 1);
  const colTotals = int(cDepth, 1);
  const colOrder = int(cSort, 1);
  for (const x of [head, rowTotals, rowOrder, colTotals, colOrder]) if (isError(x)) return x;
  const skip = head === 1 || head === 3 ? 1 : 0;
  const rows = kept(values.rows, filter, ctx);
  if (isError(rows)) return rows;
  const used = rows.filter((r) => r >= skip);
  const rowGroups = group(rowKeys, used, rowOrder as number);
  const colGroups = group(colKeys, used, colOrder as number);
  // Empty places in the table are empty text, as Excel gives them.
  const cell = (rs: number[]): Scalar => (rs.length ? summarise(fn, rs.map((r) => values.get(r, 0))) : '');
  const blanks = (n: number): Scalar[] => Array.from({ length: n }, (): Scalar => '');
  const out: Scalar[][] = [];
  // Column headers: one row per column field.
  for (let k = 0; k < colKeys.cols; k++) {
    const row: Scalar[] = blanks(rowKeys.cols);
    for (const g of colGroups) row.push(g.key[k]);
    if (colTotals) row.push(k === 0 ? 'Total' : '');
    out.push(row);
  }
  const colSets = colGroups.map((g) => new Set(g.rows));
  for (const g of rowGroups) {
    const row: Scalar[] = [...g.key];
    for (const set of colSets) row.push(cell(g.rows.filter((r) => set.has(r))));
    if (colTotals) row.push(cell(g.rows));
    out.push(row);
  }
  if (rowTotals) {
    const row: Scalar[] = ['Total', ...blanks(rowKeys.cols - 1)];
    for (const g of colGroups) row.push(cell(g.rows));
    if (colTotals) row.push(cell(used));
    out.push(row);
  }
  return ArrayValue.of(out);
});
