// Reads an .xlsx (or .xlsm, .xltx, .xltm) into a Workbook (docs/spreadsheets.md, "Reading and writing .xlsx"). The
// workbook part, styles, theme and shared strings are read first; then the sheets, each streamed from the package as it
// inflates (sheetScanner.ts). `readWorkbook` reads the active sheet and, unless told otherwise, the rest; `loadSheet` reads
// one later, so a big workbook can show its first sheet before the others are in.

import { readCharts } from '../charts/model.ts';
import type { XmlElement } from '@golemdocs/docx';
import { readTable } from '../tables.ts';
import { readNotes } from '../notes.ts';
import type { Table } from '../tables.ts';
import { OpcPackage, child, elements } from '@golemdocs/docx';
import { StyleTable } from '../model/styles.ts';
import { readTheme } from '../model/theme.ts';
import { Workbook, isWorksheet } from '../model/workbook.ts';
import type { DefinedName, OtherSheet } from '../model/workbook.ts';
import { Worksheet } from '../model/worksheet.ts';
import type { SheetState } from '../model/worksheet.ts';
import { SharedStringsScanner } from './sharedStrings.ts';
import { SheetScanner } from './sheetScanner.ts';
import { parseAround, readAround } from './worksheetXml.ts';

const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const STRICT_REL_BASE = 'http://purl.oclc.org/ooxml/officeDocument/relationships/';

export class WorkbookError extends Error {}

export interface ReadOptions {
  /** Read only the active sheet now (the others with loadSheet). */
  activeOnly?: boolean;
  /** Read no sheet's cells now: the workbook's structure, styles and strings only (the sheets with loadSheet). */
  structureOnly?: boolean;
  /** Called as rows come in: the sheet's index and how many of its rows are read. */
  onRows?: (sheet: number, rows: number) => void;
}

const relType = (type: string, name: string) => type === REL_BASE + name || type === STRICT_REL_BASE + name;

export async function readWorkbook(bytes: Uint8Array, options: ReadOptions = {}): Promise<Workbook> {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) throw new WorkbookError('This is an Excel 97–2003 (.xls) workbook or an encrypted one, not an .xlsx');
  const pkg = await OpcPackage.read(bytes);
  const main = (await pkg.relationships('')).list.find((r) => relType(r.type, 'officeDocument'));
  if (!main) throw new WorkbookError('Not a workbook: the package has no main part');
  const workbookPart = (await pkg.relationships('')).partName(main);
  if (/\.bin$/i.test(workbookPart)) throw new WorkbookError('Binary workbooks (.xlsb) are not supported');
  const workbookXml = await pkg.xml(workbookPart);
  const rels = await pkg.relationships(workbookPart);
  const book = new Workbook();

  const stylesRel = rels.list.find((r) => relType(r.type, 'styles'));
  const stringsRel = rels.list.find((r) => relType(r.type, 'sharedStrings'));
  const themeRel = rels.list.find((r) => relType(r.type, 'theme'));
  const stylesPart = stylesRel ? rels.partName(stylesRel) : null;
  const stringsPart = stringsRel ? rels.partName(stringsRel) : null;
  if (stylesPart && pkg.has(stylesPart)) book.styles = StyleTable.parse(await pkg.text(stylesPart));
  if (themeRel && pkg.has(rels.partName(themeRel))) book.theme = readTheme(await pkg.text(rels.partName(themeRel)));

  const pr = child(workbookXml, 'workbookPr');
  book.date1904 = pr?.attrs.date1904 === '1' || pr?.attrs.date1904 === 'true';
  const view = child(child(workbookXml, 'bookViews') ?? workbookXml, 'workbookView');
  book.activeSheet = +(view?.attrs.activeTab ?? 0);

  const parts: { part: string; rId: string; loaded: boolean }[] = [];
  for (const s of elements(child(workbookXml, 'sheets') ?? workbookXml)) {
    if (s.name !== 'sheet') continue;
    const rId = s.attrs['r:id'] ?? '';
    const rel = rels.byId(rId);
    const part = rel ? rels.partName(rel) : '';
    const state = (s.attrs.state as SheetState) ?? 'visible';
    const name = s.attrs.name ?? `Sheet${parts.length + 1}`;
    const sheetId = +(s.attrs.sheetId ?? parts.length + 1);
    const type = rel?.type ?? '';
    if (relType(type, 'worksheet')) {
      const sheet = new Worksheet(name, sheetId);
      sheet.state = state;
      book.sheets.push(sheet);
    } else {
      const kind: OtherSheet['kind'] = relType(type, 'chartsheet') ? 'chartsheet' : relType(type, 'dialogsheet') ? 'dialogsheet' : 'macrosheet';
      book.sheets.push({ kind, name, sheetId, state });
    }
    parts.push({ part, rId, loaded: false });
  }
  if (book.activeSheet >= book.sheets.length) book.activeSheet = 0;

  book.names = [...elements(child(workbookXml, 'definedNames') ?? workbookXml)]
    .filter((e) => e.name === 'definedName')
    .map((e) => {
      const { name, localSheetId, hidden, ...attrs } = e.attrs;
      const defined: DefinedName = { name: name ?? '', formula: e.children.filter((c) => typeof c === 'string').join('') };
      if (localSheetId !== undefined) defined.sheet = +localSheetId;
      if (hidden === '1' || hidden === 'true') defined.hidden = true;
      if (Object.keys(attrs).length) defined.attrs = attrs;
      return defined;
    });

  book.source = { pkg, workbookPart, workbookXml, parts, stylesPart, stringsPart, sharedCount: 0 };

  if (stringsPart && pkg.has(stringsPart)) {
    const scanner = new SharedStringsScanner(book.strings);
    for await (const piece of pkg.stream(stringsPart)) scanner.push(piece);
  }
  book.source.sharedCount = book.strings.count;

  const order = [book.activeSheet, ...book.sheets.map((_, i) => i).filter((i) => i !== book.activeSheet)];
  if (options.structureOnly) return book;
  for (const i of options.activeOnly ? [book.activeSheet] : order) await loadSheet(book, i, options.onRows);
  return book;
}

/** Reads a sheet's cells, if they are not read yet. */
/**
 * Reads a sheet's cells, if they are not read yet. `pause`, if given, is awaited every so often while the sheet streams in,
 * so whoever reads it can answer other requests meanwhile (the worker draws the rows read so far).
 */
export async function loadSheet(book: Workbook, index: number, onRows?: (sheet: number, rows: number) => void, pause?: () => Promise<void>): Promise<void> {
  const source = book.source;
  const sheet = book.sheets[index];
  if (!source || !sheet || !isWorksheet(sheet) || source.parts[index].loaded) return;
  source.parts[index].loaded = true;
  const { part } = source.parts[index];
  if (!source.pkg.has(part)) return;
  const scanner = new SheetScanner(sheet, book.strings);
  if (onRows) scanner.onRows = (rows) => onRows(index, rows);
  let paused = performance.now();
  for await (const piece of source.pkg.stream(part)) {
    scanner.push(piece);
    if (pause && performance.now() - paused > 50) {
      await pause();
      paused = performance.now();
    }
  }
  scanner.finish();
  const prefix = concat(scanner.prefix);
  const suffix = concat(scanner.suffix);
  sheet.xml = { prefix, suffix };
  const root = parseAround(prefix, suffix);
  readAround(sheet, root);
  sheet.tables = await readTables(source.pkg, part, root);
  const { notes, parts } = await readNotes(source.pkg, part, root);
  sheet.notes = notes;
  sheet.noteParts = parts;
  sheet.charts = await readCharts(source.pkg, part, root, book.theme.colors);
}

/** The tables a sheet's `<tableParts>` point to. */
async function readTables(pkg: OpcPackage, part: string, root: XmlElement): Promise<Table[]> {
  const parts = [...elements(child(root, 'tableParts') ?? root)].filter((e) => e.name === 'tablePart');
  if (!parts.length) return [];
  const rels = await pkg.relationships(part);
  const tables: Table[] = [];
  for (const p of parts) {
    const rel = rels.byId(p.attrs['r:id'] ?? '');
    if (!rel) continue;
    const name = rels.partName(rel);
    if (!pkg.has(name)) continue;
    const table = readTable(await pkg.xml(name), name);
    if (table) tables.push({ ...table, rId: rel.id });
  }
  return tables;
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
