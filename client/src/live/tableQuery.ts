// A table's rows, filtered, sorted and cut down (docs/live-blocks.md §7, "a table from a CSV or sheet with a filter"): the
// options after `?` in any address that gives a table, `![[Meals.csv?where=Day:Mon;Calories>2000&sort=-Calories&columns=Day,Meal&limit=5]]`.
//
//   where     conditions, all of which a row must meet, joined by `;`: `Column:value` or `Column=value` (the same, ignoring case),
//             `!=`, `>`, `>=`, `<`, `<=` (as numbers when both are, else as text: ISO dates compare in order), `~` (contains)
//   sort      a column, `-Column` for largest first; rows that tie keep their order
//   columns   the columns to keep, in this order
//   limit     the most rows to show
//
// Columns are named by their heading, or by their letter (A, B…) when the table has none. A table the filter leaves empty
// keeps its heading. Like a producer, it gives the same rows on every device.

import type { LiveResult } from './result.ts';

const letter = (i: number): string => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** A cell's number, ignoring the currency, the thousands separators and a percent sign; null when it is not one. */
function numberOf(text: string): number | null {
  const plain = text.replace(/[\s$€£¥,%]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(plain)) return null;
  const n = Number(plain);
  return Number.isFinite(n) ? n : null;
}

/** -1, 0 or 1: as numbers when both are, else as text (English rules, ignoring case and accents). */
function compare(a: string, b: string): number {
  const x = numberOf(a);
  const y = numberOf(b);
  if (x !== null && y !== null) return Math.sign(x - y);
  return Math.sign(a.trim().localeCompare(b.trim(), 'en', { sensitivity: 'base', numeric: true }));
}

const CONDITION = /^(.+?)\s*(!=|>=|<=|=|:|>|<|~)\s*(.*)$/s;

/** Applies an address's options to its result; anything but a table is left as it is. */
export function queryTable(result: LiveResult, options: ReadonlyMap<string, string>): LiveResult {
  if (result.kind !== 'table') return result;
  const heading = result.header ? result.rows[0] : null;
  const width = Math.max(0, ...result.rows.map((r) => r.length));
  const names = heading ?? Array.from({ length: width }, (_, i) => letter(i));
  const column = (name: string): number => {
    const wanted = name.trim().toLowerCase();
    const at = names.findIndex((n) => n.trim().toLowerCase() === wanted);
    return at >= 0 || heading === null ? at : Array.from({ length: width }, (_, i) => letter(i).toLowerCase()).indexOf(wanted);
  };
  const missing = (name: string): LiveResult => ({ kind: 'error', code: 'notFound', detail: name.trim() });
  let rows = heading ? result.rows.slice(1) : result.rows.slice();

  for (const condition of (options.get('where') ?? '').split(';').map((c) => c.trim()).filter(Boolean)) {
    const m = CONDITION.exec(condition);
    if (!m) return { kind: 'error', code: 'unsupported', detail: condition };
    const at = column(m[1]);
    if (at < 0) return missing(m[1]);
    const value = m[3].trim();
    const test = (cell: string): boolean => {
      switch (m[2]) {
        case '!=':
          return compare(cell, value) !== 0;
        case '>':
          return compare(cell, value) > 0;
        case '>=':
          return compare(cell, value) >= 0;
        case '<':
          return compare(cell, value) < 0;
        case '<=':
          return compare(cell, value) <= 0;
        case '~':
          return cell.toLowerCase().includes(value.toLowerCase());
        default:
          return compare(cell, value) === 0;
      }
    };
    rows = rows.filter((r) => test(r[at] ?? ''));
  }

  const sort = options.get('sort')?.trim();
  if (sort) {
    const desc = sort.startsWith('-');
    const at = column(desc ? sort.slice(1) : sort);
    if (at < 0) return missing(desc ? sort.slice(1) : sort);
    rows = rows.map((r, i) => ({ r, i })).sort((a, b) => (desc ? -1 : 1) * compare(a.r[at] ?? '', b.r[at] ?? '') || a.i - b.i).map((x) => x.r);
  }

  const limit = Number(options.get('limit'));
  if (options.has('limit') && Number.isInteger(limit) && limit >= 0) rows = rows.slice(0, limit);

  let align = result.align;
  let head = heading;
  const keep = (options.get('columns') ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  if (keep.length) {
    const at = keep.map(column);
    const unknown = keep.find((_, i) => at[i] < 0);
    if (unknown !== undefined) return missing(unknown);
    const pick = (r: string[]) => at.map((c) => r[c] ?? '');
    rows = rows.map(pick);
    head = head && pick(head);
    align = at.map((c) => result.align[c] ?? 'left');
  }
  if (!head && !rows.length) return { kind: 'error', code: 'empty' };
  return { ...result, rows: head ? [head, ...rows] : rows, align };
}
