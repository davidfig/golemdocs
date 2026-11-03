// Date and time functions, on serial dates: days since 1900-01-00 with Excel's phantom 29 February 1900 (day 60), or since
// 1904-01-01 in a workbook that uses that system.

import { dateParts } from '../../format/numberFormat.ts';
import { parseDateInput } from '../../input.ts';
import { numbers } from '../runtime.ts';
import type { Context } from '../runtime.ts';
import { BLANK, NUM, VALUE, isError, num, toBool, toNumber, toText } from '../values.ts';
import type { FormulaError, Scalar, Value } from '../values.ts';
import { define } from './registry.ts';

const DAY_MS = 86_400_000;
/** The largest serial date (9999-12-31). */
const MAX_DATE = 2958465;

/** The serial of a date, months and days past their ends carried over (DATE(2024,13,1) is 2025-01-01). */
export function serial(y: number, m: number, d: number, date1904: boolean): number {
  y += Math.floor((m - 1) / 12);
  m = ((((m - 1) % 12) + 12) % 12) + 1;
  if (date1904) return (Date.UTC(y, m - 1, 1) - Date.UTC(1904, 0, 1)) / DAY_MS + d - 1;
  let first = (Date.UTC(y, m - 1, 1) - Date.UTC(1899, 11, 31)) / DAY_MS;
  if (y > 1900 || (y === 1900 && m >= 3)) first++;
  return first + d - 1;
}

/** A serial's year, month and day (1904 or not). */
export const ymd = (s: number, date1904: boolean): { y: number; m: number; d: number } => dateParts(Math.floor(s), date1904);

const daysInMonth = (y: number, m: number): number => (y === 1900 && m === 2 ? 29 : new Date(Date.UTC(y, m, 0)).getUTCDate());
const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The day of the week, 0 for Sunday. */
export const weekday = (s: number, date1904: boolean): number => (((Math.floor(s) + (date1904 ? 1462 : 0) + 6) % 7) + 7) % 7;

/** A date argument: a number not below 0 nor past 9999, or text that reads as a date. */
function dateArg(v: Value | undefined, ctx: Context): number | FormulaError {
  if (v === undefined || v === BLANK) return 0;
  if (typeof v === 'string') {
    const parsed = parseDateInput(v, ctx.host.date1904);
    if (parsed) return parsed.value;
  }
  const n = toNumber(v as Scalar);
  if (isError(n)) return n;
  if (n < 0 || n > MAX_DATE + 0.99999999) return NUM;
  return n;
}

function numberArg(v: Value | undefined, fallback: number): number | FormulaError {
  if (v === undefined || v === BLANK) return fallback;
  return toNumber(v as Scalar);
}

define('DATE', 3, 3, 'value', ([a, b, c], ctx) => {
  const y = toNumber(a as Scalar);
  if (isError(y)) return y;
  const m = toNumber(b as Scalar);
  if (isError(m)) return m;
  const d = toNumber(c as Scalar);
  if (isError(d)) return d;
  let year = Math.trunc(y);
  if (year < 0 || year >= 10000) return NUM;
  if (year < 1900 && !ctx.host.date1904) year += 1900;
  if (year < 1904 && ctx.host.date1904) year += 1900;
  const s = serial(year, Math.trunc(m), Math.trunc(d), ctx.host.date1904);
  return s < 0 || s > MAX_DATE ? NUM : s;
});
define('TIME', 3, 3, 'value', ([a, b, c]) => {
  const h = toNumber(a as Scalar);
  if (isError(h)) return h;
  const m = toNumber(b as Scalar);
  if (isError(m)) return m;
  const s = toNumber(c as Scalar);
  if (isError(s)) return s;
  const seconds = Math.trunc(h) * 3600 + Math.trunc(m) * 60 + Math.trunc(s);
  if (seconds < 0) return NUM;
  return (seconds % 86400) / 86400;
});

function part(name: string, fn: (s: number, ctx: Context) => number): void {
  define(name, 1, 1, 'value', ([v], ctx) => {
    const s = dateArg(v, ctx);
    return isError(s) ? s : fn(s, ctx);
  });
}
part('YEAR', (s, ctx) => ymd(s, ctx.host.date1904).y);
part('MONTH', (s, ctx) => ymd(s, ctx.host.date1904).m);
part('DAY', (s, ctx) => ymd(s, ctx.host.date1904).d);
/** A time's parts, to the nearest second (MINUTE(0.7604166) is 15: 18:14:59.994 rounds up). */
const clock = (s: number) => dateParts(Math.round(s * 86400) / 86400);
part('HOUR', (s) => clock(s).H);
part('MINUTE', (s) => clock(s).M);
part('SECOND', (s) => clock(s).S);

define('WEEKDAY', 1, 2, 'value', ([v, t], ctx) => {
  const s = dateArg(v, ctx);
  if (isError(s)) return s;
  const type = numberArg(t, 1);
  if (isError(type)) return type;
  const dow = weekday(s, ctx.host.date1904);
  const k = Math.trunc(type);
  if (k === 1 || k === 17) return dow + 1;
  if (k === 2 || k === 11) return ((dow + 6) % 7) + 1;
  if (k === 3) return (dow + 6) % 7;
  if (k >= 12 && k <= 16) return ((dow - (k - 10) + 7) % 7) + 1;
  return NUM;
});

/** The ISO week number. */
function isoWeek(s: number, date1904: boolean): number {
  const { y, m, d } = ymd(s, date1904);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  return Math.ceil(((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / DAY_MS + 1) / 7);
}

define('WEEKNUM', 1, 2, 'value', ([v, t], ctx) => {
  const s = dateArg(v, ctx);
  if (isError(s)) return s;
  const type = numberArg(t, 1);
  if (isError(type)) return type;
  const k = Math.trunc(type);
  if (k === 21) return isoWeek(s, ctx.host.date1904);
  // The day weeks start on: 1 and 17 Sunday, 2 and 11 Monday, 12-16 Tuesday to Saturday.
  const start = k === 1 || k === 17 ? 0 : k === 2 || k === 11 ? 1 : k >= 12 && k <= 16 ? k - 10 : -1;
  if (start < 0) return NUM;
  const { y } = ymd(s, ctx.host.date1904);
  const jan1 = serial(y, 1, 1, ctx.host.date1904);
  const offset = (weekday(jan1, ctx.host.date1904) - start + 7) % 7;
  return Math.floor((Math.floor(s) - jan1 + offset) / 7) + 1;
});
part('ISOWEEKNUM', (s, ctx) => isoWeek(s, ctx.host.date1904));

/** A month later or earlier, its day kept or the month's last. */
function addMonths(s: number, months: number, endOfMonth: boolean, date1904: boolean): number {
  const { y, m, d } = ymd(s, date1904);
  const total = y * 12 + (m - 1) + Math.trunc(months);
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = daysInMonth(ny, nm);
  return serial(ny, nm, endOfMonth ? last : Math.min(d, last), date1904);
}
define('EDATE', 2, 2, 'value', ([a, b], ctx) => {
  const s = dateArg(a, ctx);
  if (isError(s)) return s;
  const n = toNumber(b as Scalar);
  if (isError(n)) return n;
  const r = addMonths(s, n, false, ctx.host.date1904);
  return r < 0 || r > MAX_DATE ? NUM : r;
});
define('EOMONTH', 2, 2, 'value', ([a, b], ctx) => {
  const s = dateArg(a, ctx);
  if (isError(s)) return s;
  const n = toNumber(b as Scalar);
  if (isError(n)) return n;
  const r = addMonths(s, n, true, ctx.host.date1904);
  return r < 0 || r > MAX_DATE ? NUM : r;
});

define('DATEDIF', 3, 3, 'value', ([a, b, u], ctx) => {
  const s = dateArg(a, ctx);
  if (isError(s)) return s;
  const e = dateArg(b, ctx);
  if (isError(e)) return e;
  const unit = toText(u as Scalar);
  if (isError(unit)) return unit;
  if (s > e) return NUM;
  const p = ymd(s, ctx.host.date1904);
  const q = ymd(e, ctx.host.date1904);
  let months = (q.y - p.y) * 12 + q.m - p.m;
  if (q.d < p.d) months--;
  switch (unit.toUpperCase()) {
    case 'Y':
      return Math.floor(months / 12);
    case 'M':
      return months;
    case 'D':
      return Math.floor(e) - Math.floor(s);
    case 'MD': {
      if (q.d >= p.d) return q.d - p.d;
      const pm = q.m === 1 ? 12 : q.m - 1;
      const py = q.m === 1 ? q.y - 1 : q.y;
      return daysInMonth(py, pm) - p.d + q.d;
    }
    case 'YM':
      return ((months % 12) + 12) % 12;
    case 'YD': {
      let start = serial(q.y, p.m, p.d, ctx.host.date1904);
      if (start > Math.floor(e)) start = serial(q.y - 1, p.m, p.d, ctx.host.date1904);
      return Math.floor(e) - start;
    }
    default:
      return NUM;
  }
});
define('DAYS', 2, 2, 'value', ([a, b], ctx) => {
  const e = dateArg(a, ctx);
  if (isError(e)) return e;
  const s = dateArg(b, ctx);
  if (isError(s)) return s;
  return Math.floor(e) - Math.floor(s);
});

/** Days between two dates counting 30-day months (US/NASD, or European). */
export function days360(s: number, e: number, european: boolean, date1904: boolean): number {
  const p = ymd(s, date1904);
  const q = ymd(e, date1904);
  let sd = p.d;
  let ed = q.d;
  if (european) {
    if (sd === 31) sd = 30;
    if (ed === 31) ed = 30;
  } else {
    const lastFeb = (x: { y: number; m: number; d: number }) => x.m === 2 && x.d === daysInMonth(x.y, 2);
    if (lastFeb(p) && lastFeb(q)) ed = 30;
    if (lastFeb(p)) sd = 30;
    if (ed === 31 && sd >= 30) ed = 30;
    if (sd === 31) sd = 30;
  }
  return (q.y - p.y) * 360 + (q.m - p.m) * 30 + ed - sd;
}
define('DAYS360', 2, 3, 'value', ([a, b, m], ctx) => {
  const s = dateArg(a, ctx);
  if (isError(s)) return s;
  const e = dateArg(b, ctx);
  if (isError(e)) return e;
  const eu = m === undefined || m === BLANK ? false : toBool(m as Scalar);
  if (isError(eu)) return eu;
  return days360(s, e, eu, ctx.host.date1904);
});

/** YEARFRAC's year fraction for a day-count basis (0 US 30/360, 1 actual/actual, 2 actual/360, 3 actual/365, 4 European 30/360). */
export function yearFrac(s: number, e: number, basis: number, date1904: boolean): number | FormulaError {
  if (s > e) [s, e] = [e, s];
  s = Math.floor(s);
  e = Math.floor(e);
  switch (basis) {
    case 0: {
      // The US method of YEARFRAC differs from DAYS360's: a start at February's end counts as the 30th only when the end is too.
      const p = ymd(s, date1904);
      const q = ymd(e, date1904);
      let sd = p.d;
      let ed = q.d;
      const lastFeb = (x: { y: number; m: number; d: number }) => x.m === 2 && x.d === daysInMonth(x.y, 2);
      if (ed === 31 && sd >= 30) ed = 30;
      if (sd === 31) sd = 30;
      if (lastFeb(p)) {
        sd = 30;
        if (lastFeb(q)) ed = 30;
      }
      return ((q.y - p.y) * 360 + (q.m - p.m) * 30 + ed - sd) / 360;
    }
    case 1: {
      const p = ymd(s, date1904);
      const q = ymd(e, date1904);
      const days = e - s;
      if (p.y === q.y) return days / (isLeap(p.y) ? 366 : 365);
      const yearLater = serial(p.y + 1, p.m, p.d, date1904);
      if (e <= yearLater) {
        const spansLeapDay = (isLeap(p.y) && s <= serial(p.y, 2, 29, date1904)) || (isLeap(q.y) && e >= serial(q.y, 2, 29, date1904));
        return days / (spansLeapDay ? 366 : 365);
      }
      let total = 0;
      for (let y = p.y; y <= q.y; y++) total += isLeap(y) ? 366 : 365;
      return days / (total / (q.y - p.y + 1));
    }
    case 2:
      return (e - s) / 360;
    case 3:
      return (e - s) / 365;
    case 4:
      return days360(s, e, true, date1904) / 360;
    default:
      return NUM;
  }
}
define('YEARFRAC', 2, 3, 'value', ([a, b, c], ctx) => {
  const s = dateArg(a, ctx);
  if (isError(s)) return s;
  const e = dateArg(b, ctx);
  if (isError(e)) return e;
  const basis = numberArg(c, 0);
  if (isError(basis)) return basis;
  return yearFrac(s, e, Math.trunc(basis), ctx.host.date1904);
});

/** Which days are the weekend (0 Sunday): from a WORKDAY.INTL code (1-7, 11-17) or a "0000011" mask. */
function weekendDays(v: Value | undefined): boolean[] | FormulaError {
  const days = [false, false, false, false, false, false, false];
  if (v === undefined || v === BLANK) {
    days[0] = days[6] = true;
    return days;
  }
  if (typeof v === 'string') {
    if (!/^[01]{7}$/.test(v) || v === '1111111') return VALUE;
    // Monday first.
    for (let i = 0; i < 7; i++) days[(i + 1) % 7] = v[i] === '1';
    return days;
  }
  const n = toNumber(v as Scalar);
  if (isError(n)) return n;
  const k = Math.trunc(n);
  if (k >= 1 && k <= 7) {
    // 1: Saturday and Sunday, 2: Sunday and Monday, ... 7: Friday and Saturday.
    days[(k + 5) % 7] = true;
    days[(k + 6) % 7] = true;
    return days;
  }
  if (k >= 11 && k <= 17) {
    days[(k - 10) % 7] = true;
    return days;
  }
  return NUM;
}

function holidaySet(v: Value | undefined, ctx: Context): Set<number> | FormulaError {
  if (v === undefined || v === BLANK) return new Set();
  const ns = numbers([v], ctx);
  if (isError(ns)) return ns;
  return new Set(ns.map(Math.floor));
}

function networkDays(name: string, intl: boolean): void {
  define(name, 2, intl ? 4 : 3, ['value', 'value', ...(intl ? (['value', 'any'] as const) : (['any'] as const))], (args, ctx) => {
    const s = dateArg(args[0], ctx);
    if (isError(s)) return s;
    const e = dateArg(args[1], ctx);
    if (isError(e)) return e;
    const weekend = weekendDays(intl ? args[2] : undefined);
    if (isError(weekend)) return weekend;
    const holidays = holidaySet(intl ? args[3] : args[2], ctx);
    if (isError(holidays)) return holidays;
    const from = Math.floor(Math.min(s, e));
    const to = Math.floor(Math.max(s, e));
    let count = 0;
    for (let d = from; d <= to; d++) if (!weekend[weekday(d, ctx.host.date1904)] && !holidays.has(d)) count++;
    return s > e ? -count : count;
  });
}
networkDays('NETWORKDAYS', false);
networkDays('NETWORKDAYS.INTL', true);

function workday(name: string, intl: boolean): void {
  define(name, 2, intl ? 4 : 3, ['value', 'value', ...(intl ? (['value', 'any'] as const) : (['any'] as const))], (args, ctx) => {
    const s = dateArg(args[0], ctx);
    if (isError(s)) return s;
    const n = toNumber(args[1] as Scalar);
    if (isError(n)) return n;
    const weekend = weekendDays(intl ? args[2] : undefined);
    if (isError(weekend)) return weekend;
    const holidays = holidaySet(intl ? args[3] : args[2], ctx);
    if (isError(holidays)) return holidays;
    let d = Math.floor(s);
    let left = Math.trunc(n);
    const step = left < 0 ? -1 : 1;
    while (left !== 0) {
      d += step;
      if (d < 0 || d > MAX_DATE) return NUM;
      if (!weekend[weekday(d, ctx.host.date1904)] && !holidays.has(d)) left -= step;
    }
    return d;
  });
}
workday('WORKDAY', false);
workday('WORKDAY.INTL', true);

define('DATEVALUE', 1, 1, 'value', ([v], ctx) => {
  const t = toText(v as Scalar);
  if (isError(t)) return t;
  const parsed = parseDateInput(t, ctx.host.date1904);
  return parsed ? Math.floor(parsed.value) : VALUE;
});
define('TIMEVALUE', 1, 1, 'value', ([v], ctx) => {
  const t = toText(v as Scalar);
  if (isError(t)) return t;
  const parsed = parseDateInput(t, ctx.host.date1904);
  return parsed ? num(parsed.value - Math.floor(parsed.value)) : VALUE;
});
define('NOW', 0, 0, 'value', (_, ctx) => ctx.host.now(), true);
define('TODAY', 0, 0, 'value', (_, ctx) => Math.floor(ctx.host.now()), true);
