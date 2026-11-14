// A spreadsheet as a live block's host (docs/live-blocks.md §3): a range filled from a source, anchored at its top-left cell
// and kept as a hidden defined name (sheetRanges.ts). An update writes the result's cells over the range (each cell keeping its own formatting), clears what the
// old result filled beyond the new one, and moves the name to the new extent. A result that would need cells beyond what
// the last one filled that hold something (or belong to another live range) is not written: the block keeps its last
// result and reports `blocked`.
//
// A table gives its cells, a value one cell; numbers are written as numbers, so formulas can use them. A picture or a part
// of a text document has no cells to give: the block says so and keeps its last result.

import type { LiveOptions } from './owner.ts';
import { ownership } from './owner.ts';
import { Kind, columnName } from '../sheet/model/column.ts';
import { Engine } from '../sheet/formula/engine.ts';
import { isWorksheet } from '../sheet/model/workbook.ts';
import type { Workbook } from '../sheet/model/workbook.ts';
import type { CellRange, Worksheet } from '../sheet/model/worksheet.ts';
import { loadSheet, readWorkbook } from '../sheet/xlsx/read.ts';
import { writeWorkbook } from '../sheet/xlsx/write.ts';
import { liveTagText } from './liveMarks.ts';
import { formulaOf, sheetLiveRanges } from './sheetRanges.ts';
import type { SheetLive } from './sheetRanges.ts';
import { externalCellsRead, externalTitle, refreshExternal } from '../sheet/externals.ts';
import type { LiveResult } from './result.ts';
import { resultOf, stampOf } from './sources.ts';
import type { SourceLookup } from './sources.ts';
import type { UpdateReport } from './update.ts';

/** A shown number as the number it is ("2,100", "-3.5"), or null when the text is not just a number (a percentage or a
 * date stays text: written as a number it would lose what it means without its format). Digits with a leading zero ("02134",
 * a zip code or an id) stay text too: as a number they would lose the zero. */
export function numberOf(text: string): number | null {
  const m = /^\s*(-?)([\d,]*\.?\d+)\s*$/.exec(text);
  if (!m || (m[2].includes(',') && !/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(m[2]))) return null;
  if (/^0[\d,]/.test(m[2])) return null;
  const n = Number(m[2].replace(/,/g, '')) * (m[1] ? -1 : 1);
  return Number.isFinite(n) ? n : null;
}

/** A result's cells, as rows; null when it has none (a picture, part of a text document). */
function cellsOf(result: LiveResult): string[][] | null {
  if (result.kind === 'table') return result.rows;
  if (result.kind === 'value') return [[result.text]];
  return null;
}

/** The range a result's cells fill from a live range's top left. */
function extentOf(old: CellRange, rows: string[][]): CellRange {
  const width = Math.max(1, ...rows.map((r) => r.length));
  return { r0: old.r0, c0: old.c0, r1: old.r0 + Math.max(rows.length, 1) - 1, c1: old.c0 + width - 1 };
}

const inside = (r: number, c: number, x: CellRange | null): boolean => x !== null && r >= x.r0 && r <= x.r1 && c >= x.c0 && c <= x.c1;
const overlaps = (a: CellRange, b: CellRange): boolean => a.r0 <= b.r1 && a.r1 >= b.r0 && a.c0 <= b.c1 && a.c1 >= b.c0;

/**
 * The first cell (A1) in the way of a live range filling `next`: one outside what its last result filled (`owned`; null
 * before its first update, when even its anchor cell is the person's) that holds a value or a formula, or one in another
 * live range. Null when there is room. Nothing is ever written over the person's cells.
 */
function blockedAt(book: Workbook, sheetIndex: number, sheet: Worksheet, self: SheetLive, owned: CellRange | null, next: CellRange): string | null {
  for (const other of sheetLiveRanges(book)) {
    if (other.name === self.name || other.sheet !== sheetIndex || !overlaps(other.range, next)) continue;
    const r = Math.max(other.range.r0, next.r0);
    const c = Math.max(other.range.c0, next.c0);
    return `${columnName(c)}${r + 1}`;
  }
  for (let c = next.c0; c <= next.c1; c++) {
    const column = sheet.grid.columns[c];
    if (!column) continue;
    for (let r = next.r0; r <= next.r1; r++) {
      if (inside(r, c, owned)) continue;
      const kind = column.kind(r);
      if ((kind !== Kind.Empty && kind !== Kind.Blank) || column.formulaAt(r)) return `${columnName(c)}${r + 1}`;
    }
  }
  return null;
}

/** Writes a result's cells over `next` (from a live range's top left), clearing what `old` filled beyond it; formulas in
 * either are taken out, since the cells are the source's now. */
function fill(book: Workbook, sheet: Worksheet, old: CellRange, next: CellRange, rows: string[][]): void {
  const { r0, c0 } = next;
  const styleAt = (r: number, c: number): number => sheet.grid.columns[c]?.style(r) ?? 0;
  // What the old result filled and the new one does not is cleared (its formatting stays, as Excel's Clear Contents).
  for (let r = old.r0; r <= old.r1; r++) for (let c = old.c0; c <= old.c1; c++) if (r > next.r1 || c > next.c1) sheet.grid.set(r, c, Kind.Empty, 0, styleAt(r, c));
  for (const x of [old, next]) for (let c = x.c0; c <= x.c1; c++) if (sheet.grid.columns[c]?.formulas.length) sheet.grid.columns[c]!.setFormulas(x.r0, x.r1, null);
  for (let r = next.r0; r <= next.r1; r++) {
    for (let c = next.c0; c <= next.c1; c++) {
      const text = rows[r - r0]?.[c - c0] ?? '';
      const number = numberOf(text);
      if (!text) sheet.grid.set(r, c, Kind.Empty, 0, styleAt(r, c));
      else if (number !== null) sheet.grid.set(r, c, Kind.Number, number, styleAt(r, c));
      else sheet.grid.set(r, c, Kind.String, book.strings.add(text), styleAt(r, c));
    }
  }
  sheet.grid.measure();
  sheet.dirty.cells = true;
}

/** Brings a workbook's live ranges up to date, in place; what happened to each. */
export async function updateSheetLive(book: Workbook, lookup: SourceLookup, options: LiveOptions = {}): Promise<UpdateReport> {
  const report: UpdateReport = { updated: 0, problems: [] };
  const files = new Map<string, ReturnType<SourceLookup>>();
  for (const live of sheetLiveRanges(book)) {
    // Someone else's range keeps what it came with (owner.ts).
    const own = await ownership(live.tag, options);
    if (!own.mine) {
      report.problems.push({ source: live.tag.source, code: 'foreign' });
      continue;
    }
    const result = await resultOf(live.tag.source, lookup, files);
    if (result.kind === 'error') {
      report.problems.push({ source: live.tag.source, code: result.code, ...(result.detail !== undefined && { detail: result.detail }) });
      continue;
    }
    const rows = cellsOf(result);
    if (!rows) {
      report.problems.push({ source: live.tag.source, code: 'unsupported' });
      continue;
    }
    const stamp = stampOf(result);
    if (stamp === live.tag.stamp && !options.force) continue;
    const sheet = book.sheets[live.sheet];
    if (!sheet || !isWorksheet(sheet)) continue;
    await loadSheet(book, live.sheet);
    const range = extentOf(live.range, rows);
    // A result that needs cells the person (or another live range) is using keeps its last one, and says so.
    const blocked = blockedAt(book, live.sheet, sheet, live, live.tag.stamp ? live.range : null, range);
    if (blocked) {
      report.problems.push({ source: live.tag.source, code: 'blocked', detail: blocked });
      continue;
    }
    fill(book, sheet, live.range, range, rows);
    live.name.formula = formulaOf(sheet, range);
    live.name.attrs = { ...live.name.attrs, comment: liveTagText({ source: live.tag.source, stamp, by: own.by }) };
    book.dirty = true;
    report.updated++;
  }
  return report;
}

/**
 * Refreshes the values a workbook keeps from the other workbooks its formulas read (`=[Bank.xlsx]Rates!B2`), from the
 * vault's copies of them: how many links changed, and the ones whose workbook is not there.
 */
export async function refreshExternals(book: Workbook, lookup: SourceLookup): Promise<UpdateReport> {
  const report: UpdateReport = { updated: 0, problems: [] };
  if (!book.externals.length) return report;
  for (let i = 0; i < book.sheets.length; i++) await loadSheet(book, i);
  const read = externalCellsRead(book);
  for (const ext of book.externals) {
    const title = externalTitle(ext.target);
    const found = await lookup(title).catch(() => null);
    if (!found || found.cycle) {
      report.problems.push({ source: title, code: found?.cycle ? 'cycle' : 'missing', detail: title });
      continue;
    }
    let source: Workbook;
    try {
      source = await readWorkbook(found.bytes, { structureOnly: true });
      for (let i = 0; i < source.sheets.length; i++) {
        const sheet = source.sheets[i];
        if (isWorksheet(sheet) && ext.sheets.some((n) => n.toLowerCase() === sheet.name.toLowerCase())) await loadSheet(source, i);
      }
    } catch {
      report.problems.push({ source: title, code: 'unreadable', detail: title });
      continue;
    }
    if (refreshExternal(ext, read.get(ext), source)) {
      book.dirty = true;
      report.updated++;
    }
  }
  return report;
}

/** A stored workbook's bytes with its live ranges and the values it keeps from other workbooks up to date (null when none changed). */
export async function updateStoredSheet(bytes: Uint8Array, lookup: SourceLookup, options: LiveOptions = {}): Promise<{ bytes: Uint8Array | null; report: UpdateReport }> {
  const none = { bytes: null, report: { updated: 0, problems: [] } };
  let book: Workbook;
  try {
    book = await readWorkbook(bytes, { structureOnly: true });
  } catch {
    return none;
  }
  if (!sheetLiveRanges(book).length && !book.externals.length) return none;
  const report = await updateSheetLive(book, lookup, options);
  const linked = await refreshExternals(book, lookup);
  report.updated += linked.updated;
  report.problems.push(...linked.problems);
  if (!report.updated) return { bytes: null, report };
  // Formulas that read the filled cells are worked out again, so what shows the workbook in turn sees their new values.
  for (let i = 0; i < book.sheets.length; i++) await loadSheet(book, i);
  // A sheet is written again only when marked: those whose values changed are.
  for (const box of new Engine(book).recalculateAll()) {
    const sheet = book.sheets[box.sheet];
    if (sheet && isWorksheet(sheet)) sheet.dirty.cells = true;
  }
  return { bytes: await writeWorkbook(book, { recalculate: true }), report };
}
