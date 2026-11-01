// Text functions. Lengths and positions count UTF-16 code units, as Excel does (an emoji is 2).

import { numberFormat } from '../../format/numberFormat.ts';
import { eachValue, toArray } from '../runtime.ts';
import { ArrayValue, BLANK, NA, VALUE, isError, num, toBool, toNumber, toText } from '../values.ts';
import type { FormulaError, Scalar, Value } from '../values.ts';
import { wildcard } from './criteria.ts';
import { round } from './math.ts';
import { MANY, alias, define } from './registry.ts';

const text = (v: Value): string | FormulaError => toText(v as Scalar);
const number = (v: Value | undefined, fallback: number): number | FormulaError => (v === undefined || v === BLANK ? fallback : toNumber(v as Scalar));

define('LEN', 1, 1, 'value', ([v]) => {
  const s = text(v);
  return isError(s) ? s : s.length;
});
define('LEFT', 1, 2, 'value', ([v, n]) => {
  const s = text(v);
  if (isError(s)) return s;
  const k = number(n, 1);
  if (isError(k)) return k;
  return k < 0 ? VALUE : s.slice(0, Math.trunc(k));
});
define('RIGHT', 1, 2, 'value', ([v, n]) => {
  const s = text(v);
  if (isError(s)) return s;
  const k = number(n, 1);
  if (isError(k)) return k;
  if (k < 0) return VALUE;
  const t = Math.trunc(k);
  return t === 0 ? '' : s.slice(-t);
});
define('MID', 3, 3, 'value', ([v, a, n]) => {
  const s = text(v);
  if (isError(s)) return s;
  const start = toNumber(a as Scalar);
  if (isError(start)) return start;
  const k = toNumber(n as Scalar);
  if (isError(k)) return k;
  if (start < 1 || k < 0) return VALUE;
  const from = Math.trunc(start) - 1;
  return s.slice(from, from + Math.trunc(k));
});
alias('LEFTB', 'LEFT');
alias('RIGHTB', 'RIGHT');
alias('MIDB', 'MID');
alias('LENB', 'LEN');

define('UPPER', 1, 1, 'value', ([v]) => {
  const s = text(v);
  // Letters whose capital is two letters (ß) stay as they are, as in Excel.
  return isError(s) ? s : Array.from(s, (ch) => (ch.toUpperCase().length === ch.length ? ch.toUpperCase() : ch)).join('');
});
define('LOWER', 1, 1, 'value', ([v]) => {
  const s = text(v);
  return isError(s) ? s : s.toLowerCase();
});
define('PROPER', 1, 1, 'value', ([v]) => {
  const s = text(v);
  if (isError(s)) return s;
  // A letter after a non-letter is capitalised, every other letter lowered.
  let out = '';
  let prevLetter = false;
  for (const ch of s) {
    const letter = ch.toLowerCase() !== ch.toUpperCase();
    out += letter ? (prevLetter ? ch.toLowerCase() : ch.toUpperCase()) : ch;
    prevLetter = letter;
  }
  return out;
});
define('TRIM', 1, 1, 'value', ([v]) => {
  const s = text(v);
  return isError(s) ? s : s.replace(/ +/g, ' ').replace(/^ | $/g, '');
});
define('CLEAN', 1, 1, 'value', ([v]) => {
  const s = text(v);
  return isError(s) ? s : s.replace(/[\x00-\x1f]/g, '');
});
define('REPT', 2, 2, 'value', ([v, n]) => {
  const s = text(v);
  if (isError(s)) return s;
  const k = toNumber(n as Scalar);
  if (isError(k)) return k;
  if (k < 0 || s.length * Math.trunc(k) > 32767) return VALUE;
  return s.repeat(Math.trunc(k));
});
define('EXACT', 2, 2, 'value', ([a, b]) => {
  const s = text(a);
  if (isError(s)) return s;
  const t = text(b);
  return isError(t) ? t : s === t;
});
define('CODE', 1, 1, 'value', ([v]) => {
  const s = text(v);
  if (isError(s)) return s;
  return s ? s.charCodeAt(0) : VALUE;
});
define('UNICODE', 1, 1, 'value', ([v]) => {
  const s = text(v);
  if (isError(s)) return s;
  return s ? s.codePointAt(0)! : VALUE;
});
define('CHAR', 1, 1, 'value', ([v]) => {
  const n = toNumber(v as Scalar);
  if (isError(n)) return n;
  const k = Math.trunc(n);
  if (k < 1 || k > 255) return VALUE;
  // Windows-1252, as Excel uses.
  const cp1252 = '€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8dŽ\x8f\x90‘’“”•–—˜™š›œ\x9džŸ';
  return k >= 128 && k < 160 ? cp1252[k - 128] : String.fromCharCode(k);
});
define('UNICHAR', 1, 1, 'value', ([v]) => {
  const n = toNumber(v as Scalar);
  if (isError(n)) return n;
  const k = Math.trunc(n);
  if (k < 1 || k > 0x10ffff || (k >= 0xd800 && k <= 0xdfff)) return VALUE;
  return String.fromCodePoint(k);
});

function find(name: string, caseless: boolean): void {
  define(name, 2, 3, 'value', ([f, w, s]) => {
    const needle = text(f);
    if (isError(needle)) return needle;
    const hay = text(w);
    if (isError(hay)) return hay;
    const start = number(s, 1);
    if (isError(start)) return start;
    const from = Math.trunc(start) - 1;
    if (from < 0 || from > hay.length) return VALUE;
    if (!caseless) {
      const i = hay.indexOf(needle, from);
      return i < 0 ? VALUE : i + 1;
    }
    if (!/[*?~]/.test(needle)) {
      const i = hay.toLowerCase().indexOf(needle.toLowerCase(), from);
      return i < 0 ? VALUE : i + 1;
    }
    // SEARCH with wildcards: the first position where the pattern matches.
    const re = new RegExp(wildcard(needle).source.slice(1, -1), 'i');
    const m = re.exec(hay.slice(from));
    return m ? from + m.index + 1 : VALUE;
  });
}
find('FIND', false);
find('SEARCH', true);
alias('FINDB', 'FIND');
alias('SEARCHB', 'SEARCH');

define('SUBSTITUTE', 3, 4, 'value', ([v, o, n, k]) => {
  const s = text(v);
  if (isError(s)) return s;
  const old = text(o);
  if (isError(old)) return old;
  const repl = text(n);
  if (isError(repl)) return repl;
  if (!old) return s;
  if (k === undefined) return s.split(old).join(repl);
  const which = toNumber(k as Scalar);
  if (isError(which)) return which;
  if (which < 1) return VALUE;
  let at = -old.length;
  for (let i = 0; i < Math.trunc(which); i++) {
    at = s.indexOf(old, at + old.length);
    if (at < 0) return s;
  }
  return s.slice(0, at) + repl + s.slice(at + old.length);
});
define('REPLACE', 4, 4, 'value', ([v, a, n, r]) => {
  const s = text(v);
  if (isError(s)) return s;
  const start = toNumber(a as Scalar);
  if (isError(start)) return start;
  const k = toNumber(n as Scalar);
  if (isError(k)) return k;
  const repl = text(r);
  if (isError(repl)) return repl;
  if (start < 1 || k < 0) return VALUE;
  const from = Math.trunc(start) - 1;
  return s.slice(0, from) + repl + s.slice(from + Math.trunc(k));
});
alias('REPLACEB', 'REPLACE');

/** CONCAT and TEXTJOIN: every value of every argument, in order (ranges row by row). */
function texts(args: Value[], ctx: Parameters<typeof eachValue>[1], skipEmpty: boolean): string[] | FormulaError {
  const out: string[] = [];
  let error: FormulaError | null = null;
  for (const a of args) {
    const values = a instanceof ArrayValue ? a.data : null;
    const visit = (s: Scalar) => {
      if (isError(s)) return !!(error = s);
      const t = toText(s) as string;
      if (!(skipEmpty && t === '')) out.push(t);
    };
    if (values) values.forEach(visit);
    else {
      const arr = toArray(a, ctx);
      if (isError(arr)) return arr;
      for (const s of arr.data) if (visit(s)) break;
    }
    if (error) return error;
  }
  return out;
}

define('CONCAT', 1, MANY, 'any', (args, ctx) => {
  const t = texts(args, ctx, false);
  if (isError(t)) return t;
  const s = t.join('');
  return s.length > 32767 ? VALUE : s;
});
define('CONCATENATE', 1, MANY, 'value', (args) => {
  let out = '';
  for (const a of args) {
    const s = text(a);
    if (isError(s)) return s;
    out += s;
  }
  return out;
});
define('TEXTJOIN', 3, MANY, ['any', 'value', 'any'], ([d, skip, ...rest], ctx) => {
  const ignore = toBool(skip as Scalar);
  if (isError(ignore)) return ignore;
  const delims = texts([d], ctx, false);
  if (isError(delims)) return delims;
  const t = texts(rest, ctx, ignore);
  if (isError(t)) return t;
  let out = '';
  t.forEach((s, i) => (out += (i ? delims[(i - 1) % Math.max(1, delims.length)] ?? '' : '') + s));
  return out.length > 32767 ? VALUE : out;
});

define('T', 1, 1, 'value', ([v]) => (typeof v === 'string' ? v : isError(v) ? v : ''));
define('VALUE', 1, 1, 'value', ([v]) => {
  if (typeof v === 'number') return v;
  if (v === BLANK) return 0;
  if (typeof v === 'boolean') return VALUE;
  return toNumber(v as Scalar);
});
define('NUMBERVALUE', 1, 3, 'value', ([v, d, g]) => {
  const s = text(v);
  if (isError(s)) return s;
  const dec = d === undefined ? '.' : text(d);
  if (isError(dec)) return dec;
  const group = g === undefined ? ',' : text(g);
  if (isError(group)) return group;
  let t = s.replace(/\s+/g, '');
  if (!t) return 0;
  const sep = dec[0] ?? '.';
  const grp = group[0] ?? ',';
  const at = t.indexOf(sep);
  let intPart = at < 0 ? t : t.slice(0, at);
  const fracPart = at < 0 ? '' : t.slice(at + 1);
  if (fracPart.includes(grp) || fracPart.includes(sep)) return VALUE;
  intPart = intPart.split(grp).join('');
  t = intPart + (at < 0 ? '' : '.' + fracPart);
  let percents = 0;
  while (t.endsWith('%')) {
    percents++;
    t = t.slice(0, -1);
  }
  const n = Number(t);
  if (!t || Number.isNaN(n)) return VALUE;
  return num(n / 100 ** percents);
});

define('TEXT', 2, 2, 'value', ([v, f], ctx) => {
  const code = text(f);
  if (isError(code)) return code;
  if (isError(v)) return v;
  const format = numberFormat(code);
  let value: Scalar = v as Scalar;
  if (typeof value === 'string') {
    const n = toNumber(value);
    if (isError(n)) return format.formatText(value).text;
    value = n;
  }
  if (typeof value === 'boolean') return format.formatText(value ? 'TRUE' : 'FALSE').text;
  const shown = format.format(value === BLANK ? 0 : (value as number), ctx.host.date1904);
  return shown.error ? VALUE : shown.text;
});

/** FIXED and DOLLAR: a number rounded and shown with grouping (and a currency sign). */
function fixedText(value: number, decimals: number, grouping: boolean, currency: boolean): string {
  const d = Math.trunc(decimals);
  const r = round(value, d);
  const places = Math.max(0, d);
  const body = (grouping ? '#,##0' : '0') + (places ? '.' + '0'.repeat(places) : '');
  const code = currency ? `$${body}_);($${body})` : body;
  return numberFormat(code).format(r).text.replace(/ $/, '');
}
define('FIXED', 1, 3, 'value', ([v, d, g]) => {
  const n = toNumber(v as Scalar);
  if (isError(n)) return n;
  const decimals = number(d, 2);
  if (isError(decimals)) return decimals;
  const noCommas = g === undefined ? false : toBool(g as Scalar);
  if (isError(noCommas)) return noCommas;
  if (decimals > 127) return VALUE;
  return fixedText(n, decimals, !noCommas, false);
});
define('DOLLAR', 1, 2, 'value', ([v, d]) => {
  const n = toNumber(v as Scalar);
  if (isError(n)) return n;
  const decimals = number(d, 2);
  if (isError(decimals)) return decimals;
  return fixedText(n, decimals, true, true);
});
alias('USDOLLAR', 'DOLLAR');

/** TEXTBEFORE and TEXTAFTER: the text before or after the nth delimiter (from the end when negative). */
function textAround(name: string, after: boolean): void {
  define(name, 2, 6, ['value', 'any', 'value'], ([v, d, n, mode, end, missing], ctx) => {
    const s = text(v);
    if (isError(s)) return s;
    const delims = texts([d], ctx, false);
    if (isError(delims)) return delims;
    const instance = number(n, 1);
    if (isError(instance)) return instance;
    const caseless = number(mode, 0);
    if (isError(caseless)) return caseless;
    const matchEnd = number(end, 0);
    if (isError(matchEnd)) return matchEnd;
    const k = Math.trunc(instance);
    if (k === 0 || Math.abs(k) > s.length + 1) return VALUE;
    const hay = caseless ? s.toLowerCase() : s;
    const ds = delims.map((x) => (caseless ? x.toLowerCase() : x));
    // Every place a delimiter starts, with its length.
    const hits: [number, number][] = [];
    for (let i = 0; i <= hay.length; i++) {
      for (const x of ds) {
        if (x === '' ? true : hay.startsWith(x, i)) {
          hits.push([i, x.length]);
          i += Math.max(0, x.length - 1);
          break;
        }
      }
    }
    if (matchEnd) {
      if (k > 0) hits.push([s.length, 0]);
      else hits.unshift([0, 0]);
    }
    const hit = k > 0 ? hits[k - 1] : hits[hits.length + k];
    if (!hit) return missing !== undefined ? (missing as Scalar) : NA;
    return after ? s.slice(hit[0] + hit[1]) : s.slice(0, hit[0]);
  });
}
textAround('TEXTBEFORE', false);
textAround('TEXTAFTER', true);

define('TEXTSPLIT', 2, 6, ['value', 'any', 'any', 'value'], ([v, cd, rd, ignore, mode, pad], ctx) => {
  const s = text(v);
  if (isError(s)) return s;
  const colDelims = cd === BLANK ? [] : texts([cd], ctx, false);
  if (isError(colDelims)) return colDelims;
  const rowDelims = rd === undefined || rd === BLANK ? [] : texts([rd], ctx, false);
  if (isError(rowDelims)) return rowDelims;
  const skip = ignore === undefined ? false : toBool(ignore as Scalar);
  if (isError(skip)) return skip;
  const caseless = number(mode, 0);
  if (isError(caseless)) return caseless;
  const split = (t: string, ds: string[]): string[] => {
    const usable = ds.filter((x) => x !== '');
    if (!usable.length) return [t];
    const escaped = usable.map((x) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
    const parts = t.split(new RegExp(escaped, caseless ? 'i' : ''));
    return skip ? parts.filter((p) => p !== '') : parts;
  };
  const rows = split(s, rowDelims).map((r) => split(r, colDelims));
  const cols = Math.max(...rows.map((r) => r.length));
  const filler: Scalar = pad === undefined ? NA : (pad as Scalar);
  return new ArrayValue(rows.length, cols, rows.flatMap((r) => Array.from({ length: cols }, (_, i) => (i < r.length ? r[i] : filler))));
});

define('ASC', 1, 1, 'value', ([v]) => text(v));
define('DBCS', 1, 1, 'value', ([v]) => text(v));
alias('JIS', 'DBCS');
