// What typing into a cell means, as Excel (en-US) reads it: a formula, a number (with grouping, currency, percent, a
// fraction), a date or time, a logical, an error, or text. Excel also gives a General cell the format the typing implied
// ("$1,234.50" makes it currency, "5%" a percentage, "3/4/2024" a date), so that comes back too.

import { Kind, errorCode } from './model/column.ts';

export type Parsed =
  | { kind: 'formula'; text: string }
  | { kind: typeof Kind.Number; value: number; format?: string }
  | { kind: typeof Kind.String; text: string; quoted?: boolean }
  | { kind: typeof Kind.Boolean; value: 0 | 1 }
  | { kind: typeof Kind.Error; value: number }
  | { kind: typeof Kind.Empty };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function parseInput(input: string, date1904 = false): Parsed {
  if (input === '') return { kind: Kind.Empty };
  if (input.startsWith('=') && input.length > 1) return { kind: 'formula', text: input.slice(1) };
  if (input.startsWith("'")) return { kind: Kind.String, text: input.slice(1), quoted: true };
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return { kind: Kind.Boolean, value: upper === 'TRUE' ? 1 : 0 };
  const error = errorCode(upper);
  if (error >= 0) return { kind: Kind.Error, value: error };
  const number = parseNumberInput(trimmed);
  if (number) return { kind: Kind.Number, ...number };
  const date = parseDateInput(trimmed, date1904);
  if (date) return { kind: Kind.Number, ...date };
  return { kind: Kind.String, text: input };
}

/** "1,234.5", "-12%", "$1,000", "(42)", "1.5E3", "1 1/2". */
export function parseNumberInput(text: string): { value: number; format?: string } | null {
  let s = text;
  let negative = false;
  let percent = false;
  let currency = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) s = s.slice(1).trim();
  if (s.startsWith('$')) {
    currency = true;
    s = s.slice(1).trim();
    if (s.startsWith('-')) {
      negative = !negative;
      s = s.slice(1).trim();
    }
  }
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1).trim();
  }
  // A fraction has a whole part ("1 3/4", "0 3/4"): a plain "3/4" is a date to Excel.
  const fraction = /^(\d+) (\d+)\/(\d+)$/.exec(s);
  if (fraction && !currency && !percent) {
    if (!+fraction[3]) return null;
    const value = +fraction[1] + +fraction[2] / +fraction[3];
    return { value: negative ? -value : value, format: fraction[3].length > 1 ? '# ??/??' : '# ?/?' };
  }
  const grouped = /^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s);
  if (!grouped && !/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  let value = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  if (percent) value /= 100;
  if (negative) value = -value;
  const decimals = /\.(\d+)/.exec(s)?.[1].length ?? 0;
  const format = currency ? (decimals ? '"$"#,##0.00_);\\("$"#,##0.00\\)' : '"$"#,##0_);\\("$"#,##0\\)') : percent ? (decimals ? '0.00%' : '0%') : grouped ? (decimals ? '#,##0.00' : '#,##0') : /e/i.test(s) ? '0.00E+00' : undefined;
  return format ? { value, format } : { value };
}

/** A date, a time, or both, as Excel reads them typed: the serial number and the format it gives the cell. */
export function parseDateInput(text: string, date1904 = false): { value: number; format: string } | null {
  const s = text.trim().toLowerCase();
  let date: { y: number; m: number; d: number; format: string } | null = null;
  let rest = s;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) {
    date = { y: +m[1], m: +m[2], d: +m[3], format: 'yyyy-mm-dd' };
    rest = s.slice(m[0].length);
  } else if ((m = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/.exec(s))) {
    date = { y: m[3] === undefined ? new Date().getFullYear() : twoDigitYear(+m[3], m[3].length), m: +m[1], d: +m[2], format: m[3] === undefined ? 'd-mmm' : 'm/d/yyyy' };
    rest = s.slice(m[0].length);
  } else if ((m = /^(\d{1,2})[ -]([a-z]{3,9})(?:[ -](\d{2,4}))?/.exec(s)) && monthOf(m[2]) >= 0) {
    date = { y: m[3] === undefined ? new Date().getFullYear() : twoDigitYear(+m[3], m[3].length), m: monthOf(m[2]) + 1, d: +m[1], format: m[3] === undefined ? 'd-mmm' : 'd-mmm-yy' };
    rest = s.slice(m[0].length);
  } else if ((m = /^([a-z]{3,9})\.? (\d{1,2})(?:,? (\d{2,4}))?/.exec(s)) && monthOf(m[1]) >= 0) {
    date = { y: m[3] === undefined ? new Date().getFullYear() : twoDigitYear(+m[3], m[3].length), m: monthOf(m[1]) + 1, d: +m[2], format: m[3] === undefined ? 'd-mmm' : 'd-mmm-yy' };
    rest = s.slice(m[0].length);
  }
  if (date && (date.m < 1 || date.m > 12 || date.d < 1 || date.d > daysIn(date.y, date.m))) return null;
  rest = rest.trim();
  let time: { fraction: number; format: string } | null = null;
  if (rest) {
    const t = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*(am|pm|a|p)?$/.exec(rest);
    if (!t) return null;
    let hours = +t[1];
    if (t[4]) {
      if (hours > 12 || hours === 0) return null;
      hours = (hours % 12) + (t[4][0] === 'p' ? 12 : 0);
    }
    if (+t[2] > 59 || (t[3] && +t[3] >= 60)) return null;
    time = { fraction: (hours * 3600 + +t[2] * 60 + (t[3] ? +t[3] : 0)) / 86400, format: t[4] ? (t[3] ? 'h:mm:ss AM/PM' : 'h:mm AM/PM') : t[3] ? 'h:mm:ss' : 'h:mm' };
  }
  if (!date && !time) return null;
  const serial = date ? toSerial(date.y, date.m, date.d, date1904) : 0;
  if (serial === null) return null;
  const format = date && time ? 'm/d/yyyy h:mm' : date ? date.format : time!.format;
  return { value: serial + (time?.fraction ?? 0), format };
}

const monthOf = (name: string): number => (name.length >= 3 ? MONTHS.indexOf(name.slice(0, 3)) : -1);
const daysIn = (y: number, m: number): number => (y === 1900 && m === 2 ? 29 : new Date(Date.UTC(y, m, 0)).getUTCDate());
/** Excel's two-digit years: 00-29 are 2000-2029, 30-99 are 1930-1999. */
const twoDigitYear = (y: number, digits: number): number => (digits <= 2 ? (y < 30 ? 2000 + y : 1900 + y) : y);

/** A date's serial number (Excel's 1900 system with its 29 February 1900, or 1904), or null before the system's start. */
export function toSerial(y: number, m: number, d: number, date1904 = false): number | null {
  if (date1904) {
    const days = (Date.UTC(y, m - 1, d) - Date.UTC(1904, 0, 1)) / 86_400_000;
    return days < 0 ? null : days;
  }
  if (y === 1900 && m === 2 && d === 29) return 60;
  const days = (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 31)) / 86_400_000;
  if (days < 1) return null;
  return days >= 60 ? days + 1 : days;
}
