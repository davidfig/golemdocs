// Where a workbook keeps its live blocks (docs/live-blocks.md §3): each is a hidden defined name, `_golem_live_<n>`, that
// refers to the range it fills, with its source and stamp in the name's comment (`live:<source> stamp=<hash>`, as a content
// control's tag). Excel keeps both, and shows the name in its Name Manager. Small and free of the producers, so the sheet
// worker uses it to keep the ranges read-only and to add one (sheetHost.ts fills them).

import { columnName } from '../sheet/model/column.ts';
import type { DefinedName, Workbook } from '../sheet/model/workbook.ts';
import type { CellRange, Worksheet } from '../sheet/model/worksheet.ts';
import { parseRange } from '../sheet/refs.ts';
import { liveTagText, parseLiveTag } from './liveMarks.ts';
import type { LiveTag } from './liveMarks.ts';

const PREFIX = '_golem_live_';
const isLiveName = (n: DefinedName): boolean => n.name.startsWith(PREFIX) && n.hidden === true;

/** A live range in a workbook: its name, where it is, and its tag. */
export interface SheetLive {
  name: DefinedName;
  sheet: number;
  range: CellRange;
  tag: LiveTag;
}

const unquote = (s: string): string => (s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s);
const quote = (s: string): string => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`);

/** A name's formula (`Sheet1!$A$1:$C$4`) as a sheet and range; null when it is not one (#REF!, a formula). */
function rangeOf(book: Workbook, formula: string): { sheet: number; range: CellRange } | null {
  const bang = formula.lastIndexOf('!');
  if (bang < 0) return null;
  const sheetName = unquote(formula.slice(0, bang).trim());
  const range = parseRange(formula.slice(bang + 1).replace(/\$/g, ''));
  const sheet = book.sheets.findIndex((s) => s.name === sheetName);
  return range && sheet >= 0 ? { sheet, range } : null;
}

/** A sheet and range as a name's formula. */
export const formulaOf = (sheet: Worksheet, r: CellRange): string => `${quote(sheet.name)}!$${columnName(r.c0)}$${r.r0 + 1}:$${columnName(r.c1)}$${r.r1 + 1}`;

/** The live ranges of a workbook, in the order of their names. */
export function sheetLiveRanges(book: Workbook): SheetLive[] {
  const out: SheetLive[] = [];
  for (const name of book.names) {
    if (!isLiveName(name)) continue;
    const tag = parseLiveTag(name.attrs?.comment ?? '');
    const at = rangeOf(book, name.formula);
    if (tag && at) out.push({ name, ...at, tag });
  }
  return out;
}

/** The sources of a workbook's live ranges, as written (for the search index: docs/live-blocks.md §5). */
export function sheetLiveSources(book: Workbook): string[] {
  return book.names.filter(isLiveName).flatMap((n) => {
    const tag = parseLiveTag(n.attrs?.comment ?? '');
    return tag ? [tag.source] : [];
  });
}

/** Adds a live range to a workbook at a cell (empty until it is first updated); its name, or null when the cell is in
 * another live range (whose next update would write over it). */
export function addSheetLive(book: Workbook, sheet: number, row: number, col: number, source: string): DefinedName | null {
  if (liveRangeIn(book, sheet, [{ r0: row, c0: col, r1: row, c1: col }])) return null;
  const used = new Set(book.names.map((n) => n.name));
  let n = 1;
  while (used.has(`${PREFIX}${n}`)) n++;
  const name: DefinedName = { name: `${PREFIX}${n}`, formula: formulaOf(book.sheets[sheet] as Worksheet, { r0: row, c0: col, r1: row, c1: col }), hidden: true, attrs: { comment: liveTagText({ source, stamp: '' }) } };
  book.names.push(name);
  book.dirty = true;
  return name;
}

/** Stop Updating: the live range at a cell loses its name, so its cells are ordinary ones holding what they showed. */
export function removeSheetLive(book: Workbook, sheet: number, row: number, col: number): boolean {
  const live = liveRangeIn(book, sheet, [{ r0: row, c0: col, r1: row, c1: col }]);
  if (!live) return false;
  book.names = book.names.filter((n) => n !== live.name);
  book.dirty = true;
  return true;
}

/** The live range a range of a sheet runs into (an edit there would be undone by the next update), or null. */
export function liveRangeIn(book: Workbook, sheet: number, ranges: readonly CellRange[]): SheetLive | null {
  for (const live of sheetLiveRanges(book)) {
    if (live.sheet !== sheet) continue;
    const r = live.range;
    if (ranges.some((x) => x.r0 <= r.r1 && x.r1 >= r.r0 && x.c0 <= r.c1 && x.c1 >= r.c0)) return live;
  }
  return null;
}
