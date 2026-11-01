// Writes a Workbook as .xlsx (docs/spreadsheets.md, "Reading and writing .xlsx"). Every part nothing changed is copied as
// its compressed bytes, so an untouched sheet, a chart or a pivot cache comes out exactly as it went in. A sheet whose cells
// changed is written row by row and deflated as it goes (a sheet can be a gigabyte of XML), with the XML around its cells
// kept as it was except for what the model holds (worksheetXml.ts).
//
// Strings: cells whose string came from the file's shared strings keep their index, so sharedStrings.xml never changes;
// strings typed since are written inline. Formulas: a run of cells is written as one shared formula.

import { OpcPackage, child, deflatePieces, el, elements, serializeXml } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import { ERRORS, Kind, columnName } from '../model/column.ts';
import type { FormulaRun } from '../model/column.ts';
import { Workbook, isWorksheet } from '../model/workbook.ts';
import { cellKey } from '../model/worksheet.ts';
import type { Worksheet } from '../model/worksheet.ts';
import { shiftFormula } from '../formula/shift.ts';
import { parseAround, writeAround } from './worksheetXml.ts';
import { rangeName } from '../refs.ts';
import { tableXml } from '../tables.ts';
import { writeNotes } from '../notes.ts';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const BAND = 4096;

export interface WriteOptions {
  /** Ask Excel to recalculate everything on opening (while values may be stale: until the engine recalculates them). */
  recalculate?: boolean;
  /** Awaited every so often while a sheet is written, so the writer's caller can answer other requests meanwhile. */
  pause?: () => Promise<void>;
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (c) => `_x${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}_`);
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

/** A number as .xlsx writes it: the shortest text that reads back as the same double. */
export const numberText = (v: number): string => (Object.is(v, -0) ? '0' : String(v).replace('e', 'E'));

export async function writeWorkbook(book: Workbook, options: WriteOptions = {}): Promise<Uint8Array> {
  const recalculate = options.recalculate ?? true;
  if (!book.source) await adopt(book);
  const source = book.source!;
  const { pkg } = source;
  const rels = await pkg.relationships(source.workbookPart);
  const sharedCount = source.sharedCount;
  let cellsChanged = false;

  for (const [i, sheet] of book.sheets.entries()) {
    if (!isWorksheet(sheet)) continue;
    const entry = source.parts[i];
    if (!entry.part) {
      // A sheet added here: a new part, its relationship and its content type.
      entry.part = pkg.uniqueName('xl/worksheets/sheet', 'xml');
      entry.rId = rels.add(`${REL}/worksheet`, entry.part);
      entry.loaded = true;
      sheet.dirty.cells = true;
      book.dirty = true;
    }
    if (!entry.loaded || (!sheet.dirty.cells && !sheet.dirty.layout)) continue;
    cellsChanged ||= sheet.dirty.cells;
    const sheetRels = await pkg.relationships(entry.part);
    for (const rel of sheetRels.list.filter((r) => r.type === `${REL}/table`)) {
      if (sheet.tables.some((t) => t.rId === rel.id)) continue;
      pkg.delete(sheetRels.partName(rel));
      sheetRels.remove(rel.id);
    }
    sheet.tables = sheet.tables.map((table) => {
      if (table.part && table.rId) return table;
      const part = pkg.uniqueName('xl/tables/table', 'xml');
      return { ...table, part, rId: sheetRels.add(`${REL}/table`, part) };
    });
    for (const table of sheet.tables) pkg.set(table.part, serializeXml(tableXml(table)), `${TYPE}.table+xml`);
    if (sheet.noteParts && sheet.dirty.layout) await writeNotes(pkg, sheet.notes, sheet.noteParts);
    const pieces = sheetPieces(book, sheet, sharedCount);
    const deflated = await deflatePieces(options.pause ? withPauses(pieces, options.pause) : pieces);
    pkg.setDeflated(entry.part, deflated, `${TYPE}.worksheet+xml`);
  }

  if (cellsChanged && !rels.list.some((r) => r.type === `${REL}/sheetMetadata`) && hasDynamicArrays(book)) {
    // A dynamic-array formula (cm="1") points at the cell metadata that says so; a workbook without any gets it.
    const part = pkg.has('xl/metadata.xml') ? pkg.uniqueName('xl/metadata', 'xml') : 'xl/metadata.xml';
    pkg.set(part, new TextEncoder().encode(DYNAMIC_ARRAY_METADATA), `${TYPE}.sheetMetadata+xml`);
    rels.add(`${REL}/sheetMetadata`, part);
  }

  // Deleted sheets' parts go, with the workbook's relationships to them.
  for (const part of source.removed ?? []) {
    for (const rel of rels.list.filter((r) => rels.partName(r) === part)) rels.remove(rel.id);
    pkg.delete(part);
  }
  source.removed = [];

  if (book.styles.dirty) {
    let part = source.stylesPart;
    if (!part) {
      part = source.stylesPart = 'xl/styles.xml';
      rels.add(`${REL}/styles`, part);
    }
    pkg.set(part, book.styles.serialize(), `${TYPE}.styles+xml`);
  }

  if (cellsChanged) {
    // calcChain lists the cells with formulas in Excel's order of calculation; one that names a cell without a formula
    // makes Excel repair the file. Excel rebuilds it, so it goes whenever cells changed.
    const chain = rels.list.find((r) => r.type === `${REL}/calcChain`);
    if (chain) {
      pkg.delete(rels.partName(chain));
      rels.remove(chain.id);
    }
  }

  if (book.dirty || (cellsChanged && recalculate)) writeWorkbookPart(book, recalculate && cellsChanged);
  return pkg.write();
}

/** The cell metadata Excel writes for dynamic arrays: entry 1 (cm="1") is a dynamic array. */
const DYNAMIC_ARRAY_METADATA =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray">' +
  '<metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes>' +
  '<futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata>' +
  '<cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata></metadata>';

function hasDynamicArrays(book: Workbook): boolean {
  return book.sheets.some((sheet) => isWorksheet(sheet) && sheet.grid.columns.some((column) => column?.formulas.some((run) => run.dynamic && run.kind === 'array')));
}

/** The pieces, with a pause after every 50 ms of making them. */
async function* withPauses(pieces: Iterable<Uint8Array>, pause: () => Promise<void>): AsyncGenerator<Uint8Array> {
  let since = performance.now();
  for (const piece of pieces) {
    yield piece;
    if (performance.now() - since > 50) {
      await pause();
      since = performance.now();
    }
  }
}

/** A workbook made here gets a package with the parts every workbook has (its strings are all written inline). */
async function adopt(book: Workbook): Promise<void> {
  const pkg = OpcPackage.create();
  const workbookXml = el('workbook', { xmlns: MAIN, 'xmlns:r': REL }, [el('bookViews', {}, [el('workbookView', {})]), el('sheets'), el('calcPr', { calcId: 191029 })]);
  pkg.set('xl/workbook.xml', serializeXml(workbookXml), `${TYPE}.sheet.main+xml`);
  (await pkg.relationships('')).add(`${REL}/officeDocument`, 'xl/workbook.xml');
  book.source = { pkg, workbookPart: 'xl/workbook.xml', workbookXml, parts: book.sheets.map(() => ({ part: '', rId: '', loaded: true })), stylesPart: null, stringsPart: null, sharedCount: 0 };
  book.styles.dirty = true;
  book.dirty = true;
}

/** xl/workbook.xml with the model's sheets, names and settings; everything else in it as it was. */
function writeWorkbookPart(book: Workbook, recalculate: boolean): void {
  const source = book.source!;
  const root = source.workbookXml;
  const set = (name: string, element: XmlElement | null, after: string[]) => {
    const at = root.children.findIndex((c) => typeof c !== 'string' && c.name === name);
    if (at >= 0) {
      if (element) root.children[at] = element;
      else root.children.splice(at, 1);
      return;
    }
    if (!element) return;
    let index = 0;
    root.children.forEach((c, k) => {
      if (typeof c !== 'string' && after.includes(c.name)) index = k + 1;
    });
    root.children.splice(index, 0, element);
  };
  const pr = child(root, 'workbookPr') ?? el('workbookPr');
  if (book.date1904) pr.attrs.date1904 = '1';
  else delete pr.attrs.date1904;
  set('workbookPr', pr, ['fileVersion', 'fileSharing']);
  const views = child(root, 'bookViews') ?? el('bookViews', {}, [el('workbookView')]);
  const view = child(views, 'workbookView');
  if (view) {
    if (book.activeSheet) view.attrs.activeTab = String(book.activeSheet);
    else delete view.attrs.activeTab;
  }
  set('bookViews', views, ['fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection']);
  const sheets = el(
    'sheets',
    {},
    book.sheets.map((s, i) => el('sheet', { name: s.name, sheetId: s.sheetId, state: s.state === 'visible' ? undefined : s.state, 'r:id': source.parts[i].rId })),
  );
  set('sheets', sheets, ['fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews']);
  const names = book.names.map((n) => el('definedName', { name: n.name, localSheetId: n.sheet, hidden: n.hidden ? 1 : undefined, ...n.attrs }, [n.formula]));
  set('definedNames', names.length ? el('definedNames', {}, names) : null, ['fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews', 'sheets', 'functionGroups', 'externalReferences']);
  if (recalculate) {
    const calc = child(root, 'calcPr') ?? el('calcPr', { calcId: 191029 });
    calc.attrs.fullCalcOnLoad = '1';
    set('calcPr', calc, ['fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews', 'sheets', 'functionGroups', 'externalReferences', 'definedNames']);
  }
  source.pkg.set(source.workbookPart, serializeXml(root), `${TYPE}.sheet.main+xml`);
}

/** A worksheet part, in pieces of about a band of rows each. */
function* sheetPieces(book: Workbook, sheet: Worksheet, sharedCount: number): Generator<Uint8Array> {
  const encoder = new TextEncoder();
  const root = parseAround(sheet.xml?.prefix ?? encoder.encode(`<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><sheetData>`), sheet.xml?.suffix ?? encoder.encode('</sheetData></worksheet>'));
  const { head, tail } = writeAround(sheet, root);
  sheet.xml = { prefix: encoder.encode(head), suffix: encoder.encode(tail) };
  yield encoder.encode(head);

  const grid = sheet.grid;
  // Rows with something of their own besides cells: a height, hidden, a style, an outline level, other attributes.
  const special = new Set<number>([...sheet.rowStyles.keys(), ...sheet.rowOutline.keys(), ...sheet.rowAttrs.keys()]);
  if (!sheet.rowSizes.uniform) for (const r of sheet.rowSizes.specials()) special.add(r);
  const specialRows = [...special].sort((a, b) => a - b);
  const lastRow = Math.max(grid.rows, (specialRows[specialRows.length - 1] ?? -1) + 1);
  // Shared formula indices, numbered as the runs are first met.
  const sharedIndex = new Map<FormulaRun, number>();
  let si = 0;
  let next = 0;

  for (let r0 = 0; r0 < lastRow; r0 += BAND) {
    const r1 = Math.min(lastRow, r0 + BAND);
    // Cells of the band by row, gathered column by column (the model's grain).
    const rows: (string[] | undefined)[] = new Array(r1 - r0);
    for (let c = 0; c < grid.cols; c++) {
      const column = grid.columns[c];
      if (!column) continue;
      const name = columnName(c);
      column.forEach(r0, r1, (row, kind, value, style) => {
        (rows[row - r0] ??= []).push(cellXml(book, sheet, column.formulaAt(row), row, c, name, kind, value, style, sharedCount, sharedIndex, () => si++));
      });
    }
    let out = '';
    for (let row = r0; row < r1; row++) {
      const cells = rows[row - r0];
      const isSpecial = specialRows[next] === row;
      if (isSpecial) next++;
      if (!cells && !isSpecial) continue;
      out += rowOpen(sheet, row) + (cells ? cells.join('') : '') + '</row>';
    }
    if (out) yield encoder.encode(out);
  }
  yield encoder.encode(tail);
}

function rowOpen(sheet: Worksheet, row: number): string {
  let attrs = ` r="${row + 1}"`;
  const style = sheet.rowStyles.get(row);
  if (style !== undefined) attrs += ` s="${style}" customFormat="1"`;
  if (sheet.rowSizes.custom(row)) attrs += ` ht="${sheet.rowSizes.ownSize(row)}" customHeight="1"`;
  if (sheet.rowSizes.hidden(row)) attrs += ' hidden="1"';
  const outline = sheet.rowOutline.get(row);
  if (outline?.level) attrs += ` outlineLevel="${outline.level}"`;
  if (outline?.collapsed) attrs += ' collapsed="1"';
  return `<row${attrs}${sheet.rowAttrs.get(row) ?? ''}>`;
}

function cellXml(
  book: Workbook,
  sheet: Worksheet,
  run: FormulaRun | undefined,
  row: number,
  col: number,
  name: string,
  kind: Kind,
  value: number,
  style: number,
  sharedCount: number,
  sharedIndex: Map<FormulaRun, number>,
  nextShared: () => number,
): string {
  let attrs = ` r="${name}${row + 1}"`;
  if (style) attrs += ` s="${style}"`;
  let inner = '';
  if (run) {
    if (run.dynamic && run.kind === 'array' && row === run.first) attrs += ' cm="1"';
    inner = formulaXml(run, row, col, sharedIndex, nextShared);
  }
  switch (kind) {
    case Kind.Number:
      inner += `<v>${numberText(value)}</v>`;
      break;
    case Kind.String: {
      if (run) {
        attrs += ' t="str"';
        inner += valueXml(book.strings.get(value));
      } else if (value < sharedCount) {
        attrs += ' t="s"';
        inner += `<v>${value}</v>`;
      } else {
        attrs += ' t="inlineStr"';
        const text = book.strings.get(value);
        inner += `<is><t${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''}>${escapeText(text)}</t></is>`;
      }
      break;
    }
    case Kind.Boolean:
      attrs += ' t="b"';
      inner += `<v>${value ? 1 : 0}</v>`;
      break;
    case Kind.Error:
      attrs += ' t="e"';
      inner += `<v>${ERRORS[value] ?? '#VALUE!'}</v>`;
      break;
  }
  attrs += sheet.cellAttrs.get(cellKey(row, col)) ?? '';
  return inner ? `<c${attrs}>${inner}</c>` : `<c${attrs}/>`;
}

const valueXml = (text: string) => `<v${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''}>${escapeText(text)}</v>`;

/** A cell's `<f>`: on its own, or as the first or a following cell of a shared formula. */
function formulaXml(run: FormulaRun, row: number, col: number, sharedIndex: Map<FormulaRun, number>, nextShared: () => number): string {
  const extra = run.attrs ?? '';
  if (run.kind === 'dataTable') return row === run.first ? `<f t="dataTable"${run.ref ? ` ref="${escapeAttr(run.ref)}"` : ''}${extra}/>` : '';
  let index = sharedIndex.get(run);
  // The cells after a shared formula's first only name it: their text is never made.
  if (index !== undefined) return `<f t="shared" si="${index}"/>`;
  const text = escapeText(row === run.originRow && col === run.originCol ? run.text : shiftFormula(run.text, row - run.originRow, col - run.originCol));
  if (run.kind === 'array') return `<f t="array" ref="${escapeAttr(run.ref ?? `${columnName(col)}${row + 1}`)}"${extra}>${text}</f>`;
  if (run.first === run.last) return `<f${extra}>${text}</f>`;
  sharedIndex.set(run, (index = nextShared()));
  return `<f t="shared" ref="${rangeName({ r0: run.first, c0: col, r1: run.last, c1: col })}" si="${index}"${extra}>${text}</f>`;
}

/** The parts of a workbook part's tree a writer needs to know exist (for tests). */
export function sheetNames(root: XmlElement): string[] {
  return [...elements(child(root, 'sheets') ?? root)].map((s) => s.attrs.name ?? '');
}
