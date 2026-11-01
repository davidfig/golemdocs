// A workbook's memory image (docs/spreadsheets.md, "The memory image"): what reading an .xlsx costs (the shared strings and
// every sheet's cells) written as the arrays the model holds, so the next open maps them instead of parsing XML. The small
// parts (workbook.xml, styles, theme, relationships) are read from the .xlsx again: it is always read to be fingerprinted.
//
// Bump SCHEMA whenever what is written here changes: older images are then ignored (and remade), never upgraded.

import type { Table } from './tables.ts';
import type { Note, NoteParts } from './notes.ts';
import { readConditional } from './conditional.ts';
import { readAutoFilter } from './filter.ts';
import { readValidations } from './validation.ts';
import { parseAround } from './xlsx/worksheetXml.ts';
import { OpcPackage } from '@golemdocs/docx';
import { Image, ImageWriter, openImage } from '../image/container.ts';
import type { Fingerprint } from '../image/container.ts';
import { Chunk, Column, MAX_COLUMNS, MAX_ROWS } from './model/column.ts';
import type { FormulaRun } from './model/column.ts';
import { Sizes } from './model/sizes.ts';
import { StringPool } from './model/strings.ts';
import { StyleTable } from './model/styles.ts';
import { readTheme } from './model/theme.ts';
import { Workbook, isWorksheet } from './model/workbook.ts';
import type { AnySheet, DefinedName } from './model/workbook.ts';
import { Worksheet } from './model/worksheet.ts';
import type { CellRange, Pane, SheetState } from './model/worksheet.ts';

export const KIND = 'sheet';
export const SCHEMA = 1;

/** Fields per chunk in the chunk table. */
const FIELDS = 9;

interface SheetJson {
  name: string;
  sheetId: number;
  state: SheetState;
  kind?: 'chartsheet' | 'dialogsheet' | 'macrosheet';
  rows: number;
  cols: number;
  formulas: [number, FormulaRun[]][];
  rowStyles: [number, number][];
  colStyles: [number, number][];
  rowOutline: [number, { level: number; collapsed: boolean }][];
  colOutline: [number, { level: number; collapsed: boolean }][];
  cellAttrs: [number, string][];
  rowAttrs: [number, string][];
  merges: CellRange[];
  tables?: Table[];
  notes?: Note[];
  noteParts?: NoteParts | null;
  pane: Pane | null;
  view: Worksheet['view'];
  rowDefault: number;
  colDefault: number;
  hasRowOwn: boolean;
  hasRowHidden: boolean;
  hasColOwn: boolean;
  hasColHidden: boolean;
  hasXml: boolean;
}

interface BookJson {
  activeSheet: number;
  date1904: boolean;
  names: DefinedName[];
  parts: { part: string; rId: string; loaded: boolean }[];
  workbookPart: string;
  stylesPart: string | null;
  stringsPart: string | null;
  sharedCount: number;
  sheets: SheetJson[];
}

/** The image of a workbook read from (or saved as) the file with this fingerprint. */
export function workbookImage(book: Workbook, source: Fingerprint): Uint8Array {
  if (!book.source) throw new Error('a workbook has an image only once it has a file');
  const writer = new ImageWriter(KIND, SCHEMA, source);
  const strings = book.strings.state();
  writer.array('strings.bytes', strings.bytes);
  writer.array('strings.offsets', strings.offsets);
  writer.array('strings.escaped', strings.escaped);

  // Every chunk of every column of every sheet, in one table, its arrays packed one after another by type.
  const table: number[] = [];
  const parts = { rows: [] as Uint16Array[], kinds: [] as Uint8Array[], values: [] as Float64Array[], styles: [] as Uint32Array[] };
  const at = { rows: 0, kinds: 0, values: 0, styles: 0 };
  const sheets: SheetJson[] = book.sheets.map((sheet, s) => {
    if (!isWorksheet(sheet)) return { ...emptySheet(sheet), kind: sheet.kind };
    const formulas: [number, FormulaRun[]][] = [];
    sheet.grid.columns.forEach((column, c) => {
      if (!column) return;
      if (column.formulas.length) formulas.push([c, column.formulas]);
      for (const { chunk } of column.chunks()) {
        const length = chunk.dense ? chunk.count : chunk.n;
        table.push(s, c, chunk.count, chunk.n, chunk.dense ? 1 : 0, at.rows, at.kinds, at.values, at.styles);
        if (!chunk.n) continue;
        if (!chunk.dense) {
          parts.rows.push(chunk.rows!.subarray(0, length));
          at.rows += length;
        }
        parts.kinds.push(chunk.kinds.subarray(0, length));
        parts.values.push(chunk.values.subarray(0, length));
        parts.styles.push(chunk.styles.subarray(0, length));
        at.kinds += length;
        at.values += length;
        at.styles += length;
      }
    });
    const rows = sheet.rowSizes.state();
    const cols = sheet.colSizes.state();
    if (rows.own) writer.array(`${s}.rowOwn`, rows.own);
    if (rows.hidden) writer.array(`${s}.rowHidden`, rows.hidden);
    if (cols.own) writer.array(`${s}.colOwn`, cols.own);
    if (cols.hidden) writer.array(`${s}.colHidden`, cols.hidden);
    if (sheet.xml) {
      writer.array(`${s}.prefix`, sheet.xml.prefix);
      writer.array(`${s}.suffix`, sheet.xml.suffix);
    }
    return {
      name: sheet.name,
      sheetId: sheet.sheetId,
      state: sheet.state,
      rows: sheet.grid.rows,
      cols: sheet.grid.cols,
      formulas,
      rowStyles: [...sheet.rowStyles],
      colStyles: [...sheet.colStyles],
      rowOutline: [...sheet.rowOutline],
      colOutline: [...sheet.colOutline],
      cellAttrs: [...sheet.cellAttrs],
      rowAttrs: [...sheet.rowAttrs],
      merges: sheet.merges,
      tables: sheet.tables,
      notes: sheet.notes,
      noteParts: sheet.noteParts,
      pane: sheet.pane,
      view: sheet.view,
      rowDefault: rows.defaultSize,
      colDefault: cols.defaultSize,
      hasRowOwn: !!rows.own,
      hasRowHidden: !!rows.hidden,
      hasColOwn: !!cols.own,
      hasColHidden: !!cols.hidden,
      hasXml: !!sheet.xml,
    };
  });
  writer.array('chunks', Uint32Array.from(table));
  writer.array('rows', join(Uint16Array, parts.rows, at.rows));
  writer.array('kinds', join(Uint8Array, parts.kinds, at.kinds));
  writer.array('values', join(Float64Array, parts.values, at.values));
  writer.array('styles', join(Uint32Array, parts.styles, at.styles));
  const { source: src } = book;
  const json: BookJson = {
    activeSheet: book.activeSheet,
    date1904: book.date1904,
    names: book.names,
    parts: src.parts,
    workbookPart: src.workbookPart,
    stylesPart: src.stylesPart,
    stringsPart: src.stringsPart,
    sharedCount: src.sharedCount,
    sheets,
  };
  writer.json('book', json);
  return writer.finish();
}

/**
 * The workbook from its image, if the image was made from exactly these .xlsx bytes by this schema; otherwise null (read
 * the .xlsx instead, then make a new image).
 */
export async function mapWorkbook(imageBytes: Uint8Array | null | undefined, xlsx: Uint8Array, source: Fingerprint): Promise<Workbook | null> {
  const image = openImage(imageBytes, KIND, SCHEMA, source);
  if (!image) return null;
  return fromImage(image, xlsx);
}

async function fromImage(image: Image, xlsx: Uint8Array): Promise<Workbook> {
  const json = image.json<BookJson>('book');
  const pkg = await OpcPackage.read(xlsx);
  const workbookXml = await pkg.xml(json.workbookPart);
  const book = new Workbook();
  if (json.stylesPart && pkg.has(json.stylesPart)) book.styles = StyleTable.parse(await pkg.text(json.stylesPart));
  const rels = await pkg.relationships(json.workbookPart);
  const themeRel = rels.list.find((r) => r.type.endsWith('/theme'));
  if (themeRel && pkg.has(rels.partName(themeRel))) book.theme = readTheme(await pkg.text(rels.partName(themeRel)));
  book.activeSheet = json.activeSheet;
  book.date1904 = json.date1904;
  book.names = json.names;
  book.strings = StringPool.from({ bytes: image.array('strings.bytes'), offsets: image.array('strings.offsets'), escaped: image.array('strings.escaped') });
  book.source = { pkg, workbookPart: json.workbookPart, workbookXml, parts: json.parts, stylesPart: json.stylesPart, stringsPart: json.stringsPart, sharedCount: json.sharedCount };

  const table = image.array<Uint32Array>('chunks');
  const rows = image.array<Uint16Array>('rows');
  const kinds = image.array<Uint8Array>('kinds');
  const values = image.array<Float64Array>('values');
  const styles = image.array<Uint32Array>('styles');
  // Chunks by sheet and column, in order.
  const chunks = new Map<number, Chunk[]>();
  for (let i = 0; i < table.length; i += FIELDS) {
    const [s, c, count, n, dense, r, k, v, st] = table.subarray(i, i + FIELDS);
    const chunk = new Chunk(count);
    chunk.n = n;
    chunk.frozen = true;
    if (n) {
      const length = dense ? count : n;
      chunk.rows = dense ? null : rows.subarray(r, r + length);
      chunk.kinds = kinds.subarray(k, k + length);
      chunk.values = values.subarray(v, v + length);
      chunk.styles = styles.subarray(st, st + length);
    }
    const key = s * MAX_COLUMNS + c;
    let list = chunks.get(key);
    if (!list) chunks.set(key, (list = []));
    list.push(chunk);
  }

  book.sheets = json.sheets.map((j, s): AnySheet => {
    if (j.kind) return { kind: j.kind, name: j.name, sheetId: j.sheetId, state: j.state };
    const sheet = new Worksheet(j.name, j.sheetId);
    sheet.state = j.state;
    const formulas = new Map(j.formulas);
    for (const [key, list] of chunks) {
      if (Math.floor(key / MAX_COLUMNS) !== s) continue;
      const c = key % MAX_COLUMNS;
      const column = new Column(list);
      column.formulas = formulas.get(c) ?? [];
      sheet.grid.columns[c] = column;
    }
    for (const [c, runs] of formulas) if (!sheet.grid.columns[c]) (sheet.grid.columns[c] = new Column()).formulas = runs;
    sheet.grid.rows = j.rows;
    sheet.grid.cols = j.cols;
    // Sizes change in place, so they get their own copies of the image's arrays.
    const copy = <T extends Float32Array | Uint8Array>(has: boolean, name: string): T | null => (has ? (image.array<T>(name).slice() as T) : null);
    sheet.rowSizes = Sizes.from(MAX_ROWS, { defaultSize: j.rowDefault, own: copy<Float32Array>(j.hasRowOwn, `${s}.rowOwn`), hidden: copy<Uint8Array>(j.hasRowHidden, `${s}.rowHidden`) });
    sheet.colSizes = Sizes.from(MAX_COLUMNS, { defaultSize: j.colDefault, own: copy<Float32Array>(j.hasColOwn, `${s}.colOwn`), hidden: copy<Uint8Array>(j.hasColHidden, `${s}.colHidden`) });
    sheet.rowStyles = new Map(j.rowStyles);
    sheet.colStyles = new Map(j.colStyles);
    sheet.rowOutline = new Map(j.rowOutline);
    sheet.colOutline = new Map(j.colOutline);
    sheet.cellAttrs = new Map(j.cellAttrs);
    sheet.rowAttrs = new Map(j.rowAttrs);
    sheet.merges = j.merges;
    sheet.tables = j.tables ?? [];
    sheet.notes = j.notes ?? [];
    sheet.noteParts = j.noteParts ?? null;
    sheet.pane = j.pane;
    sheet.view = j.view;
    if (j.hasXml) {
      sheet.xml = { prefix: image.array(`${s}.prefix`), suffix: image.array(`${s}.suffix`) };
      const around = parseAround(sheet.xml.prefix, sheet.xml.suffix);
      sheet.conditional = readConditional(around);
      sheet.autoFilter = readAutoFilter(around);
      sheet.validations = readValidations(around);
    }
    return sheet;
  });
  return book;
}

function emptySheet(sheet: AnySheet): SheetJson {
  return {
    name: sheet.name,
    sheetId: sheet.sheetId,
    state: sheet.state,
    rows: 0,
    cols: 0,
    formulas: [],
    rowStyles: [],
    colStyles: [],
    rowOutline: [],
    colOutline: [],
    cellAttrs: [],
    rowAttrs: [],
    merges: [],
    pane: null,
    view: { gridlines: true, zoom: 100, rightToLeft: false, active: { row: 0, col: 0 } },
    rowDefault: 15,
    colDefault: 48,
    hasRowOwn: false,
    hasRowHidden: false,
    hasColOwn: false,
    hasColHidden: false,
    hasXml: false,
  };
}

function join<T extends Uint8Array | Uint16Array | Uint32Array | Float64Array>(A: new (n: number) => T, parts: T[], length: number): T {
  const out = new A(length);
  let at = 0;
  for (const p of parts) {
    out.set(p as never, at);
    at += p.length;
  }
  return out;
}
