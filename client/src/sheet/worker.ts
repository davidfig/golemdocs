// The sheet worker (docs/spreadsheets.md, "The model lives in a worker"): it holds the open workbook, reads it (from its
// memory image when one matches the file, else from the .xlsx), answers the page's requests for tiles and cell contents,
// applies edits with undo, and saves. Messages are in protocol.ts.
//
// Reading gives way to the event loop between pieces, so tile requests are answered while a big sheet is still coming in.

import { chartScene } from './charts/scene.ts';
import { tableFilter } from './tables.ts';
import { hasPassword, hiddenFormula, isProtected, lockedCell } from './protection.ts';
import { fingerprint } from '../image/container.ts';
import { Kind, MAX_COLUMNS, MAX_ROWS } from './model/column.ts';
import { isWorksheet } from './model/workbook.ts';
import type { Workbook } from './model/workbook.ts';
import type { Worksheet } from './model/worksheet.ts';
import { displayText, editText } from './format/display.ts';
import { look } from './format/styleChange.ts';
import { fromFileFormula } from './formula/fileNames.ts';
import { shiftFormula } from './formula/shift.ts';
import { History } from './edit.ts';
import { Engine } from './formula/engine.ts';
import { ConditionalPainter } from './conditional.ts';
import { filterValues } from './filter.ts';
import { allows, listChoices, validationAt } from './validation.ts';
import { resolveColor } from './model/theme.ts';
import type { CellBox } from './formula/engine.ts';
import { mapWorkbook, workbookImage } from './image.ts';
import { cellTile, overviewTile, TileCache } from './tiles.ts';
import type { BookInfo, CellContent, Changed, EditOp, FromWorker, SheetInfo, ToWorker } from './protocol.ts';
import { loadSheet, readWorkbook } from './xlsx/read.ts';
import { writeWorkbook } from './xlsx/write.ts';
import { copyRange } from './clipboard.ts';
import { findNext } from './find.ts';

let book: Workbook | null = null;
let cache: TileCache | null = null;
let history: History | null = null;
let engine: Engine | null = null;
/** The open file's fingerprint (what its image must match). */
let source: { sha256: string; size: number } | null = null;
/** A save under way: edits wait for it, so the file is written from one state of the workbook (tiles and reads go on). */
let saving: Promise<unknown> | null = null;
/** A recalculation under way (it gives way to tile requests): edits and saves wait for it. */
let calculating: Promise<unknown> | null = null;

const post = (message: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer);

/** Waits until no save or recalculation is under way (another edit may start one while this waits, so it checks again). */
async function settled(): Promise<void> {
  while (saving || calculating) {
    await saving;
    await calculating;
  }
}

/** Lets messages that arrived meanwhile be handled (a read of a big file awaits this between pieces). */
const yieldToEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function info(b: Workbook): BookInfo {
  return {
    sheets: b.sheets.map((sheet, i): SheetInfo => {
      if (!isWorksheet(sheet)) {
        return { name: sheet.name, state: sheet.state, grid: false, rows: 0, cols: 0, rowSizes: { defaultSize: 15, own: null, hidden: null }, colSizes: { defaultSize: 48, own: null, hidden: null }, pane: null, gridlines: true, zoom: 100, active: { row: 0, col: 0 }, merges: [], loaded: true };
      }
      return {
        name: sheet.name,
        state: sheet.state,
        grid: true,
        rows: sheet.grid.rows,
        cols: sheet.grid.cols,
        rowSizes: sheet.rowSizes.state(),
        colSizes: sheet.colSizes.state(),
        pane: sheet.pane,
        gridlines: sheet.view.gridlines,
        zoom: sheet.view.zoom,
        active: sheet.view.active,
        merges: sheet.merges,
        loaded: b.source?.parts[i]?.loaded ?? true,
        outline: sheet.rowOutline.size || sheet.colOutline.size ? { rows: [...sheet.rowOutline].slice(0, 200000).map(([i, o]): [number, number, boolean] => [i, o.level, o.collapsed]), cols: [...sheet.colOutline].map(([i, o]): [number, number, boolean] => [i, o.level, o.collapsed]) } : undefined,
        charts: sheet.charts.length || undefined,
        protection: isProtected(sheet.protection) ? { password: hasPassword(sheet.protection) } : undefined,
        notes: sheet.notes.length ? sheet.notes.slice(0, 20000).map((n): [number, number] => [n.row, n.col]) : undefined,
        filter: sheet.autoFilter ? { range: sheet.autoFilter.range, filtered: sheet.autoFilter.columns.map((c) => sheet.autoFilter!.range.c0 + c.col) } : undefined,
        tableFilters: sheet.tables.some((t) => tableFilter(t))
          ? sheet.tables.flatMap((t) => {
              const f = tableFilter(t);
              return f ? [{ table: t.displayName, range: f.range, filtered: f.columns.filter((c) => c.values !== null).map((c) => f.range.c0 + c.col) }] : [];
            })
          : undefined,
      };
    }),
    activeSheet: b.activeSheet,
    canUndo: history?.canUndo ?? false,
    canRedo: history?.canRedo ?? false,
  };
}

async function open(bytes: Uint8Array, image: Uint8Array | null): Promise<void> {
  const started = performance.now();
  source = await fingerprint(bytes);
  const mapped = await mapWorkbook(image, bytes, source).catch(() => null);
  // From the file: the workbook's structure first, then the active sheet as it streams in (shown as it comes), then the rest.
  book = mapped ?? (await readWorkbook(bytes, { structureOnly: true }));
  cache = new TileCache(book);
  history = new History(book);
  engine = new Engine(book);
  painters = new Map();
  post({ t: 'opened', info: info(book), fromImage: !!mapped, ms: performance.now() - started });
  if (!mapped) {
    const active = book.activeSheet;
    const progress = (sheet: number, rows: number) => {
      cache!.forgetOverview(sheet);
      post({ t: 'progress', sheet, rows });
    };
    await loadSheet(book, active, progress, yieldToEvents);
    for (let i = 0; i < book.sheets.length; i++) {
      if (book.source?.parts[i]?.loaded) continue;
      await yieldToEvents();
      await loadSheet(book, i, undefined, yieldToEvents);
    }
    engine?.formulasChanged();
    post({ t: 'loaded', info: info(book) });
    // The image of what was just read, for the next open (the page keeps it next to the file).
    const made = workbookImage(book, source);
    post({ t: 'image', bytes: made.buffer as ArrayBuffer, sha256: source.sha256 }, [made.buffer as ArrayBuffer]);
  }
}

/** Each sheet's conditional formats, as they are worked out for the tiles; forgotten whenever cells change. */
let painters = new Map<number, ConditionalPainter>();

function painterFor(index: number, sheet: Worksheet): ConditionalPainter {
  let painter = painters.get(index);
  if (!painter) painters.set(index, (painter = new ConditionalPainter(engine!, index, sheet, (c) => resolveColor(c, book!.theme, 0, book!.styles.indexedColors) & 0xffffff)));
  return painter;
}

/** After typing: the message of a validation rule (with the Stop style) that does not allow what was typed, or null. */
function refused(index: number, op: EditOp): string | null {
  const sheet = book!.sheets[index];
  if (op.kind !== 'input' || !engine || !sheet || !isWorksheet(sheet) || !sheet.validations.length) return null;
  const { r0, c0, r1, c1 } = op.range;
  for (let row = r0; row <= Math.min(r1, r0 + 999); row++) {
    for (let col = c0; col <= Math.min(c1, c0 + 99); col++) {
      const rule = validationAt(sheet.validations, row, col);
      if (!rule || rule.errorStyle !== 'stop' || !rule.showError || sheet.grid.columns[col]?.formulaAt(row)) continue;
      if (!allows(rule, engine.value(index, row, col), engine, index, row, col)) return rule.error || 'invalidValue';
    }
  }
  return null;
}

/** Edits that change which sheet is at which index (the engine keys what it knows by sheet index). */
const sheetsMoved = (kind: EditOp['kind']): boolean => kind === 'addSheet' || kind === 'deleteSheet' || kind === 'moveSheet';

/** A fresh engine for the workbook as it now is; after a sheet is deleted (or comes back) every formula is calculated again. */
function resetEngine(recalculateAll: boolean): void {
  engine = new Engine(book!);
  if (recalculateAll) {
    engine.recalculateAll();
    for (let i = 0; i < book!.sheets.length; i++) cache!.forgetOverview(i);
  }
}

/** Brings formulas up to date after an edit of a sheet, adding the cells they changed to what the page redraws. */
async function recalculate(sheet: number, changed: Changed): Promise<void> {
  if (!engine || !changed.ranges.length) return;
  engine.formulasChanged();
  const boxes: CellBox[] = changed.ranges.map((r) => ({ sheet, ...r }));
  const elsewhere = new Set<number>();
  const work = engine.recalculateInSlices(boxes, yieldToEvents);
  calculating = work.catch(() => undefined);
  const done = await work.finally(() => (calculating = null));
  // Conditional formats look at the values just calculated.
  painters = new Map();
  for (const box of done) {
    if (box.sheet === sheet) changed.ranges.push({ r0: box.r0, c0: box.c0, r1: box.r1, c1: box.c1 });
    else elsewhere.add(box.sheet);
    cache!.forgetOverview(box.sheet);
  }
  if (elsewhere.size) changed.elsewhere = [...elsewhere];
}

/** For each style in a column, its few longest shown texts (by characters): what fitting the column's width must measure. */
function columnTexts(sheet: Worksheet, col: number): [string, number][] {
  const byStyle = new Map<number, string[]>();
  sheet.grid.columns[col]?.forEach(0, sheet.grid.rows, (row, kind, value, style) => {
    if (kind === Kind.Empty || kind === Kind.Blank) return;
    // Merged cells don't count, as in Excel.
    if (sheet.merges.some((m) => m.c0 !== m.c1 && m.c0 <= col && m.c1 >= col && m.r0 <= row && m.r1 >= row)) return;
    const text = displayText(book!, kind, value, style).text;
    let list = byStyle.get(style);
    if (!list) byStyle.set(style, (list = []));
    list.push(text);
    if (list.length > 64) {
      list.sort((a, b) => b.length - a.length);
      list.length = 8;
    }
  });
  const out: [string, number][] = [];
  for (const [style, list] of byStyle) for (const text of list.sort((a, b) => b.length - a.length).slice(0, 8)) out.push([text, style]);
  return out;
}

function cellContent(sheet: Worksheet, row: number, col: number): CellContent {
  const column = sheet.grid.columns[col];
  const kind = column?.kind(row) ?? Kind.Empty;
  const value = column?.value(row) ?? 0;
  const style = column?.style(row) ?? 0;
  const run = column?.formulaAt(row);
  const display = displayText(book!, kind, value, style, 255).text;
  const shown = kind === Kind.Empty ? (sheet.rowStyles.get(row) ?? sheet.colStyles.get(col) ?? 0) : style;
  const cellLook = look(book!.styles, book!.theme, shown);
  const locked = isProtected(sheet.protection) && lockedCell(book!, sheet, row, col) && { locked: true };
  if (run) {
    // A hidden cell's formula is not shown while its sheet is protected: only its value.
    if (hiddenFormula(book!, sheet, row, col)) return { input: display, display, isFormula: false, look: cellLook, ...locked };
    const text = row === run.originRow && col === run.originCol ? run.text : shiftFormula(run.text, row - run.originRow, col - run.originCol);
    return { input: '=' + fromFileFormula(text), display, isFormula: true, look: cellLook, ...(validationAt(sheet.validations, row, col)?.type === 'list' && { list: true }), ...locked };
  }
  const rule = validationAt(sheet.validations, row, col);
  return { input: editText(book!, kind, value, style), display, isFormula: false, look: cellLook, ...(rule?.type === 'list' && rule.dropDown && { list: true }), ...locked };
}

/** Where Ctrl+arrow goes from a cell: the edge of the block of filled cells it is in, or the next filled cell, or the sheet's edge. */
function jump(sheet: Worksheet, row: number, col: number, dRow: number, dCol: number): { row: number; col: number } {
  const filled = (r: number, c: number) => r >= 0 && c >= 0 && r < MAX_ROWS && c < MAX_COLUMNS && (sheet.grid.columns[c]?.kind(r) ?? Kind.Empty) !== Kind.Empty;
  const limitRow = dRow > 0 ? MAX_ROWS - 1 : 0;
  const limitCol = dCol > 0 ? MAX_COLUMNS - 1 : 0;
  let r = row;
  let c = col;
  const next = () => {
    r += dRow;
    c += dCol;
  };
  const atLimit = () => (dRow && r === limitRow) || (dCol && c === limitCol);
  if (atLimit()) return { row: r, col: c };
  if (filled(r, c) && filled(r + dRow, c + dCol)) {
    while (!atLimit() && filled(r + dRow, c + dCol)) next();
    return { row: r, col: c };
  }
  // Empty cells to skip: past the data, go straight to the edge rather than walk a million rows.
  const lastRow = sheet.grid.rows;
  const lastCol = sheet.grid.cols;
  do {
    next();
    if ((dRow > 0 && r >= lastRow) || (dCol > 0 && c >= lastCol)) return { row: dRow ? limitRow : r, col: dCol ? limitCol : c };
  } while (!atLimit() && !filled(r, c));
  return { row: r, col: c };
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const m = event.data;
  try {
    if (m.t === 'open') {
      book = null;
      await open(new Uint8Array(m.bytes), m.image ? new Uint8Array(m.image) : null);
      return;
    }
    if (!book || !cache || !history) throw new Error('no workbook is open');
    switch (m.t) {
      case 'tiles': {
        const sheet = book.sheets[m.sheet];
        if (!sheet || !isWorksheet(sheet)) return post({ t: 'tiles', id: m.id, cells: [], overview: [] });
        const conditional = sheet.conditional.length && engine ? painterFor(m.sheet, sheet) : undefined;
        const cells = m.keys.filter((k) => k.level === 0).map((k) => cellTile(book!, m.sheet, sheet, k, cache!, conditional));
        const overview = m.keys.filter((k) => k.level > 0).map((k) => overviewTile(book!, m.sheet, sheet, k, cache!));
        post({ t: 'tiles', id: m.id, cells, overview }, overview.map((o) => o.rgba.buffer as ArrayBuffer).filter((b, i, all) => b.byteLength && all.indexOf(b) === i));
        return;
      }
      case 'styles':
        return post({ t: 'styles', id: m.id, styles: m.ids.map((i) => [i, cache!.style(i)]) });
      case 'cell': {
        const sheet = book.sheets[m.sheet];
        const content = sheet && isWorksheet(sheet) ? cellContent(sheet, m.row, m.col) : { input: '', display: '', isFormula: false };
        return post({ t: 'cell', id: m.id, content });
      }
      case 'edit': {
        await settled();
        const changed = history.apply(m.sheet, m.op);
        const refusal = refused(m.sheet, m.op);
        if (refusal !== null) {
          history.refuse();
          return post({ t: 'changed', id: m.id, changed: { ranges: [], message: refusal, info: info(book) } });
        }
        cache.forgetOverview(m.sheet);
        painters = new Map();
        if (sheetsMoved(m.op.kind)) resetEngine(m.op.kind === 'deleteSheet');
        else await recalculate(m.sheet, changed);
        changed.info = info(book);
        return post({ t: 'changed', id: m.id, changed });
      }
      case 'undo':
      case 'redo': {
        await settled();
        const changed = (m.t === 'undo' ? history.undo() : history.redo()) ?? { ranges: [] };
        painters = new Map();
        for (let i = 0; i < book.sheets.length; i++) cache.forgetOverview(i);
        if (sheetsMoved(history.lastKind)) resetEngine(history.lastKind === 'deleteSheet');
        else if (changed.ranges.length) await recalculate(history.lastSheet, { ...changed, ranges: changed.select ? [changed.select] : changed.ranges });
        changed.info = info(book);
        return post({ t: 'changed', id: m.id, changed });
      }
      case 'filterValues': {
        const sheet = book.sheets[m.sheet];
        const table = m.table && sheet && isWorksheet(sheet) ? sheet.tables.find((t) => t.displayName === m.table) : undefined;
        const filter = sheet && isWorksheet(sheet) ? (m.table ? table && tableFilter(table) : sheet.autoFilter) : null;
        if (!sheet || !isWorksheet(sheet) || !filter) return post({ t: 'filterValues', id: m.id, values: [], blanks: false, shown: null, shownBlanks: true });
        const { values, blanks } = filterValues(book, sheet, filter, m.col);
        const column = filter.columns.find((c) => c.col === m.col - filter.range.c0);
        return post({ t: 'filterValues', id: m.id, values, blanks, shown: column?.values ?? null, shownBlanks: column ? column.blanks : true });
      }
      case 'charts': {
        await settled();
        const sheet = book.sheets[m.sheet];
        const scenes = sheet && isWorksheet(sheet) && engine ? sheet.charts.map((c, i) => chartScene(book!, engine!, m.sheet, sheet, c, `${m.sheet}:${i}`)) : [];
        return post({ t: 'charts', id: m.id, scenes }, scenes.flatMap((s) => [s.points.buffer, s.colors.buffer]));
      }
      case 'note': {
        const sheet = book.sheets[m.sheet];
        const note = sheet && isWorksheet(sheet) ? sheet.notes.find((n) => n.row === m.row && n.col === m.col) : undefined;
        return post({ t: 'note', id: m.id, note: note ? { author: note.author, text: note.text } : null });
      }
      case 'choices': {
        const sheet = book.sheets[m.sheet];
        const rule = sheet && isWorksheet(sheet) ? validationAt(sheet.validations, m.row, m.col) : null;
        return post({ t: 'choices', id: m.id, items: rule?.type === 'list' && engine ? listChoices(rule, engine, m.sheet) : [] });
      }
      case 'columnTexts': {
        const sheet = book.sheets[m.sheet];
        return post({ t: 'columnTexts', id: m.id, texts: sheet && isWorksheet(sheet) ? columnTexts(sheet, m.col) : [] });
      }
      case 'copy': {
        const sheet = book.sheets[m.sheet];
        const { text, html } = sheet && isWorksheet(sheet) ? copyRange(book, sheet, m.range) : { text: '', html: '' };
        return post({ t: 'copy', id: m.id, text, html });
      }
      case 'find':
        return post({ t: 'found', id: m.id, at: findNext(book, m) });
      case 'end': {
        const sheet = book.sheets[m.sheet];
        const at = sheet && isWorksheet(sheet) ? jump(sheet, m.from.row, m.from.col, m.dRow, m.dCol) : m.from;
        return post({ t: 'end', id: m.id, at });
      }
      case 'save': {
        await settled();
        // Our values are Excel's unless some formula uses what the engine cannot calculate yet: then Excel recalculates on opening.
        const writing = writeWorkbook(book, { pause: yieldToEvents, recalculate: engine?.incomplete ?? true });
        saving = writing.catch(() => undefined);
        const xlsx = await writing.finally(() => (saving = null));
        // The image is made from the workbook just written, tied to the file it was written as.
        source = await fingerprint(xlsx);
        const image = workbookImage(book, source);
        for (const sheet of book.sheets) if (isWorksheet(sheet)) sheet.dirty = { cells: false, layout: false };
        book.dirty = false;
        book.styles.dirty = false;
        post({ t: 'saved', id: m.id, xlsx: xlsx.buffer as ArrayBuffer, image: image.buffer as ArrayBuffer, sha256: source.sha256 }, [xlsx.buffer as ArrayBuffer, image.buffer as ArrayBuffer]);
        return;
      }
    }
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    if (m.t === 'open') post({ t: 'failed', message });
    else post({ t: 'error', id: 'id' in m ? m.id : 0, message });
  }
};

