// References to other workbooks (`=[1]Sheet1!A1`, or `='[Bank.xlsx]Sheet1'!A1` as people type it). A workbook keeps, for
// each workbook its formulas read, an external link part (xl/externalLinks/externalLinkN.xml): the other file's name (its
// relationship's target), its sheets' names, and the values of the cells read, as last seen. Formulas read those values
// (the engine's `external`), so recalculating never loses them; the vault graph refreshes them when the other workbook
// changes (docs/live-blocks.md §5, live/sheetHost.ts), and the part is written back with them.

import { el, elements, serializeXml } from '@golemdocs/docx';
import type { OpcPackage, XmlElement } from '@golemdocs/docx';
import { ERRORS, Kind, MAX_COLUMNS, columnName } from './model/column.ts';
import { isWorksheet } from './model/workbook.ts';
import type { Workbook } from './model/workbook.ts';
import type { Worksheet } from './model/worksheet.ts';
import { parseFormula } from './formula/parser.ts';
import type { Node, RefPart } from './formula/parser.ts';
import { parseRange } from './refs.ts';
import { BLANK, FormulaError } from './formula/values.ts';
import type { ErrorName, Scalar } from './formula/values.ts';

export interface ExternalBook {
  /** The external link part, and the workbook's relationship to it (`<externalReference r:id>`). */
  part: string;
  /** The other workbook's file, as the link names it (a path or URL; `title` is its last part). */
  target: string;
  sheets: string[];
  /** Cached values, by sheet index and then by `row * MAX_COLUMNS + col`. */
  cells: Map<number, Scalar>[];
  /** Values were refreshed: the part is written again. */
  changed?: boolean;
}

const local = (e: XmlElement): string => e.name.slice(e.name.indexOf(':') + 1);
const kids = (e: XmlElement | undefined, name: string): XmlElement[] => (e ? [...elements(e)].filter((c) => local(c) === name) : []);
const kid = (e: XmlElement | undefined, name: string): XmlElement | undefined => kids(e, name)[0];
const text = (e: XmlElement | undefined): string => (e ? e.children.map((c) => (typeof c === 'string' ? c : text(c))).join('') : '');

export const cellKey = (row: number, col: number): number => row * MAX_COLUMNS + col;

/** The file name a link's target ends in (`file:///C:\Books\Bank.xlsx`, `../Bank.xlsx`, `Bank.xlsx`). */
export function externalTitle(target: string): string {
  let name = target.replace(/[?#].*$/, '').split(/[\\/]/).pop() ?? target;
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not escaped: as written.
  }
  return name.trim();
}

function cellValue(cell: XmlElement): Scalar {
  const v = text(kid(cell, 'v'));
  switch (cell.attrs.t) {
    case 'str':
    case 's':
    case 'inlineStr':
      return v;
    case 'b':
      return v === '1' || v === 'true';
    case 'e':
      return (ERRORS as readonly string[]).includes(v) ? FormulaError.of(v as ErrorName) : FormulaError.of('#N/A');
    default: {
      if (v === '') return BLANK;
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
  }
}

/** A cell reference (`B7`) as row and column; null when it is not one. */
function cellAt(ref: string): { row: number; col: number } | null {
  const range = parseRange(ref);
  return range ? { row: range.r0, col: range.c0 } : null;
}

/** The workbook's external links, in the order its formulas number them (`[1]` is the first). */
export async function readExternals(pkg: OpcPackage, workbookPart: string, workbookXml: XmlElement): Promise<ExternalBook[]> {
  const refs = kids(kid(workbookXml, 'externalReferences'), 'externalReference');
  if (!refs.length) return [];
  const rels = await pkg.relationships(workbookPart);
  const out: ExternalBook[] = [];
  for (const ref of refs) {
    const rel = rels.byId(ref.attrs['r:id'] ?? '');
    const part = rel ? rels.partName(rel) : '';
    const book: ExternalBook = { part, target: '', sheets: [], cells: [] };
    out.push(book);
    if (!part || !pkg.has(part)) continue;
    const root = await pkg.xml(part);
    const external = kid(root, 'externalBook');
    const target = (await pkg.relationships(part)).byId(external?.attrs['r:id'] ?? '');
    book.target = target?.target ?? '';
    book.sheets = kids(kid(external, 'sheetNames'), 'sheetName').map((s) => s.attrs.val ?? '');
    book.cells = book.sheets.map(() => new Map<number, Scalar>());
    for (const data of kids(kid(external, 'sheetDataSet'), 'sheetData')) {
      const cells = book.cells[+(data.attrs.sheetId ?? -1)];
      if (!cells) continue;
      for (const row of kids(data, 'row')) {
        for (const cell of kids(row, 'cell')) {
          const at = cellAt(cell.attrs.r ?? '');
          if (at) cells.set(cellKey(at.row, at.col), cellValue(cell));
        }
      }
    }
  }
  return out;
}

/** The external book a reference's `[…]` names: its number (`1`) or its file name. */
export function externalBook(books: readonly ExternalBook[], name: string): ExternalBook | null {
  if (/^\d+$/.test(name)) return books[Number(name) - 1] ?? null;
  const wanted = externalTitle(name).toLowerCase();
  return books.find((b) => externalTitle(b.target).toLowerCase() === wanted) ?? null;
}

/** A cached value of an external book's cell (blank when it has none). */
export function externalValue(book: ExternalBook, sheet: string, row: number, col: number): Scalar | null {
  const index = book.sheets.findIndex((s) => s.toLowerCase() === sheet.toLowerCase());
  if (index < 0) return null;
  return book.cells[index].get(cellKey(row, col)) ?? BLANK;
}

/** A cached cell as written (`p` the part's namespace prefix); null for an empty one. */
function cellXml(p: string, row: number, col: number, value: Scalar): XmlElement | null {
  if (value === BLANK) return null;
  const cell = (t: string | undefined, v: string) => el(`${p}cell`, { r: `${columnName(col)}${row + 1}`, t }, [el(`${p}v`, {}, [v])]);
  if (typeof value === 'number') return cell(undefined, String(value));
  if (typeof value === 'boolean') return cell('b', value ? '1' : '0');
  if (value instanceof FormulaError) return cell('e', value.name);
  return cell('str', String(value));
}

/** Writes the cached values of the external books that were refreshed back into their parts. */
export async function writeExternals(pkg: OpcPackage, books: readonly ExternalBook[]): Promise<void> {
  for (const book of books) {
    if (!book.changed || !book.part || !pkg.has(book.part)) continue;
    const root = await pkg.xml(book.part);
    const external = kid(root, 'externalBook');
    if (!external) continue;
    const prefix = external.name.includes(':') ? external.name.slice(0, external.name.indexOf(':') + 1) : '';
    const data = book.cells.map((cells, sheetId) => {
      const rows = new Map<number, XmlElement[]>();
      for (const key of [...cells.keys()].sort((a, b) => a - b)) {
        const row = Math.floor(key / MAX_COLUMNS);
        const xml = cellXml(prefix, row, key % MAX_COLUMNS, cells.get(key)!);
        if (!xml) continue;
        let list = rows.get(row);
        if (!list) rows.set(row, (list = []));
        list.push(xml);
      }
      return el(`${prefix}sheetData`, { sheetId: String(sheetId) }, [...rows].map(([row, list]) => el(`${prefix}row`, { r: String(row + 1) }, list)));
    });
    const set = el(`${prefix}sheetDataSet`, {}, data);
    const at = external.children.findIndex((c) => typeof c !== 'string' && local(c) === 'sheetDataSet');
    if (at >= 0) external.children[at] = set;
    else {
      // After sheetNames and definedNames, as the schema orders them.
      const after = external.children.reduce<number>((n, c, i) => (typeof c !== 'string' && (local(c) === 'sheetNames' || local(c) === 'definedNames') ? i + 1 : n), 0);
      external.children.splice(after, 0, set);
    }
    pkg.set(book.part, serializeXml(root));
    book.changed = false;
  }
}

/** The cells of each external book that the workbook's formulas read (as many as `most`), by book and sheet name. */
export function externalCellsRead(book: Workbook, most = 100_000): Map<ExternalBook, Map<string, Set<number>>> {
  const out = new Map<ExternalBook, Map<string, Set<number>>>();
  if (!book.externals.length) return out;
  let count = 0;
  const add = (ext: ExternalBook, sheet: string, r0: number, c0: number, r1: number, c1: number) => {
    let sheets = out.get(ext);
    if (!sheets) out.set(ext, (sheets = new Map()));
    let cells = sheets.get(sheet.toLowerCase());
    if (!cells) sheets.set(sheet.toLowerCase(), (cells = new Set()));
    for (let r = r0; r <= r1 && count < most; r++) for (let c = c0; c <= c1 && count < most; c++, count++) cells.add(cellKey(r, c));
  };
  const at = (part: RefPart, d: number): number => (part.abs ? part.i : part.i + d);
  const walk = (node: unknown, fn: (n: Node) => void): void => {
    if (!node || typeof node !== 'object') return;
    if ('t' in node) fn(node as Node);
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, fn);
  };
  for (const sheet of book.sheets) {
    if (!isWorksheet(sheet)) continue;
    sheet.grid.columns.forEach((column, col) => {
      for (const run of column?.formulas ?? []) {
        if (!run.text.includes('[') || count >= most) continue;
        let node: Node;
        try {
          node = parseFormula(run.text);
        } catch {
          continue;
        }
        const refs: Extract<Node, { t: 'cell' | 'area' }>[] = [];
        walk(node, (n) => (n.t === 'cell' || n.t === 'area') && n.sheet?.book !== undefined && refs.push(n));
        for (const ref of refs) {
          const ext = externalBook(book.externals, ref.sheet!.book!);
          if (!ext) continue;
          for (let row = run.first; row <= run.last && count < most; row++) {
            const dRow = row - run.originRow;
            const dCol = col - run.originCol;
            if (ref.t === 'cell') add(ext, ref.sheet!.first, at(ref.row, dRow), at(ref.col, dCol), at(ref.row, dRow), at(ref.col, dCol));
            else {
              const [a, b, c, d] = [at(ref.r0, dRow), at(ref.r1, dRow), at(ref.c0, dCol), at(ref.c1, dCol)];
              add(ext, ref.sheet!.first, Math.min(a, b), Math.min(c, d), Math.max(a, b), Math.max(c, d));
            }
          }
        }
      }
    });
  }
  return out;
}

/** A cell of a workbook as a value (what a reference to it from another workbook reads). */
export function cellScalar(book: Workbook, sheet: Worksheet, row: number, col: number): Scalar {
  const column = sheet.grid.columns[col];
  const kind = column?.kind(row) ?? Kind.Empty;
  const value = column?.value(row) ?? 0;
  switch (kind) {
    case Kind.Number:
      return value;
    case Kind.String:
      return book.strings.get(value);
    case Kind.Boolean:
      return value !== 0;
    case Kind.Error:
      return FormulaError.of(ERRORS[value] ?? '#N/A');
    default:
      return BLANK;
  }
}

const same = (a: Scalar | undefined, b: Scalar): boolean => a === b || (a instanceof FormulaError && b instanceof FormulaError && a.name === b.name);

/**
 * Refreshes the values an external book keeps from the workbook it names (`source`, read with its sheets loaded): the cells
 * kept before and the ones formulas read now. Whether any changed.
 */
export function refreshExternal(ext: ExternalBook, read: Set<number> | Map<string, Set<number>> | undefined, source: Workbook): boolean {
  let changed = false;
  ext.sheets.forEach((name, index) => {
    const sheet = source.sheets.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!sheet || !isWorksheet(sheet)) return;
    const cells = ext.cells[index];
    const wanted = new Set<number>(cells.keys());
    const used = read instanceof Map ? read.get(name.toLowerCase()) : read;
    for (const key of used ?? []) wanted.add(key);
    for (const key of wanted) {
      const value = cellScalar(source, sheet, Math.floor(key / MAX_COLUMNS), key % MAX_COLUMNS);
      if (same(cells.get(key), value)) continue;
      if (value === BLANK && !cells.has(key)) continue;
      cells.set(key, value);
      changed = true;
    }
  });
  if (changed) ext.changed = true;
  return changed;
}
