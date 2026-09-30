// Delimited text (CSV, TSV) <-> document model. A file is a grid of text, so it opens as a document
// that is one table, laid out to read like a sheet: columns sized to their content (the page turns
// landscape, then squeezes, before a table would run off it), a shaded header row that repeats on
// every page, numbers right-aligned, hairline borders, compact 10pt text. Nothing is interpreted:
// every cell is exactly the text in the file, so writing it back reproduces the file, including
// its delimiter, line endings, byte order mark and text encoding (CsvExtension).
//
// Reading follows RFC 4180 and forgives what real files do: quotes inside unquoted fields, a
// missing final newline, ragged rows (short rows are padded so the table stays rectangular).

import { WordDocument } from '@word/docx';
import type { Block, Border, Inline, Paragraph, Table, TableCell, TableRow } from '@word/docx';
import { encodeText } from './textFiles.ts';
import type { CsvExtension } from './wdoc.ts';

export { decodeText } from './textFiles.ts';

export type Delimiter = ',' | '\t' | ';' | '|';

const CANDIDATES: readonly Delimiter[] = [',', '\t', ';', '|'];

/** Twips: a Letter page's text width, and its landscape counterpart. */
const PORTRAIT = 9360;
const LANDSCAPE = 12960;
/** Word's largest page (22 inches) less margins. */
const WIDEST = 31680 - 2 * 1440;
const MIN_COLUMN = 700;
const MAX_COLUMN = 6000;
const CHARACTER = 100; // 10pt Calibri, on average
const PADDING = 216; // the default 108 twip cell margins
/** Rows measured for column widths and numeric columns: enough to be representative, cheap on huge files. */
const SAMPLE = 500;

// --- Decoding ----------------------------------------------------------------------------------

/** The delimiter that splits the first lines into the same, greater-than-one, number of fields. */
export function sniffDelimiter(text: string): Delimiter {
  const lines = firstRecords(text, 10);
  let best: Delimiter = ',';
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = lines.map((line) => splitLine(line, d));
    const columns = counts[0] ?? 1;
    if (columns < 2) continue;
    const consistent = counts.filter((c) => c === columns).length;
    const score = consistent * 1000 + columns;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** The first `n` records' text (quoted newlines don't end one). */
function firstRecords(text: string, n: number): string[] {
  const out: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length && out.length < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 34) quoted = !quoted;
    else if (!quoted && (c === 10 || c === 13)) {
      out.push(text.slice(start, i));
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
  }
  if (out.length < n && start < text.length) out.push(text.slice(start));
  return out;
}

/** Number of fields in one record. */
function splitLine(line: string, d: string): number {
  let quoted = false;
  let count = 1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === d) count++;
  }
  return count;
}

// --- Parsing -----------------------------------------------------------------------------------

export interface Parsed {
  rows: string[][];
  lineEnding: '\n' | '\r\n' | '\r';
  /** The file ended with a line ending. */
  trailingNewline: boolean;
}

export function parseDelimited(text: string, delimiter: string): Parsed {
  const rows: string[][] = [];
  const firstEnding = /\r\n|\r|\n/.exec(text.replace(/"[^"]*"/g, ''))?.[0] ?? '\n';
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false; // the current field has had a character (so "" and a bare delimiter differ from nothing)
  let trailingNewline = false;
  const n = text.length;
  const endField = () => {
    row.push(field);
    field = '';
    started = false;
  };
  for (let i = 0; i < n; i++) {
    const c = text[i];
    trailingNewline = false;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && !started) {
      quoted = true;
      started = true;
    } else if (c === delimiter) {
      endField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endField();
      rows.push(row);
      row = [];
      started = false;
      trailingNewline = true;
    } else {
      field += c;
      started = true;
    }
  }
  if (!trailingNewline && (row.length > 0 || field !== '' || started)) {
    endField();
    rows.push(row);
  }
  return { rows, lineEnding: firstEnding as Parsed['lineEnding'], trailingNewline };
}

// --- Layout of the grid as a table ---------------------------------------------------------------

const NUMBER = /^[-+(]?[$€£¥]?\s?\d[\d,]*(\.\d+)?([eE][-+]?\d+)?%?\)?$|^[-+]?[$€£¥]?\.\d+%?$/;

export const isNumeric = (s: string): boolean => NUMBER.test(s.trim());

const HAIRLINE: Border = { val: 'single', sz: 4, space: 0, color: 'BFBFBF' };

function cellParagraph(text: string, right: boolean, bold: boolean): Paragraph {
  const content: Paragraph['children'] = [];
  const lines = text.split(/\r\n|\r|\n/);
  const properties = { ...(bold && { bold: true }) };
  lines.forEach((line, i) => {
    if (i > 0) content.push({ kind: 'run', properties, content: [{ kind: 'break' }], attrs: {} });
    const parts = line.split('\t');
    parts.forEach((part, j) => {
      if (j > 0) content.push({ kind: 'run', properties, content: [{ kind: 'tab' }], attrs: {} });
      if (part) content.push({ kind: 'run', properties, content: [{ kind: 'text', text: part }], attrs: {} });
    });
  });
  return { kind: 'paragraph', properties: right ? { justification: 'right' } : {}, children: content, attrs: {} };
}

/** Whether the first row reads as column titles: all text, over rows that hold numbers or differ in kind. */
function looksLikeHeader(rows: string[][], columns: number): boolean {
  if (rows.length < 2) return false;
  const first = rows[0];
  if (first.some((c) => c.trim() === '' || isNumeric(c))) return false;
  // Every column below it that is numeric makes the first row a header; an all-text grid is judged by the first row being distinct.
  for (let c = 0; c < columns; c++) {
    const below = rows.slice(1, SAMPLE).map((r) => r[c] ?? '').filter((v) => v.trim() !== '');
    if (below.length && below.every(isNumeric)) return true;
  }
  const seen = new Set(rows.slice(1, SAMPLE).flatMap((r) => r));
  return first.every((c) => !seen.has(c));
}

export async function delimitedToDocument(rows: string[][]): Promise<WordDocument> {
  const doc = await WordDocument.create();
  const columns = rows.reduce((m, r) => Math.max(m, r.length), 0) || 1;
  const grid = rows.length ? rows : [['']];
  const header = looksLikeHeader(grid, columns);

  // Numbers right-align when a column is mostly numbers.
  const numeric: boolean[] = [];
  const longest: number[] = [];
  const sample = grid.slice(0, SAMPLE);
  for (let c = 0; c < columns; c++) {
    const values = sample.slice(header ? 1 : 0).map((r) => r[c] ?? '').filter((v) => v.trim() !== '');
    numeric.push(values.length > 0 && values.filter(isNumeric).length >= values.length * 0.8);
    // Bold header text, and capitals, run wider than the average character.
    // Reduced rather than spread: a cell can hold more lines than a call takes arguments (an unclosed quote swallows the file).
    longest.push(
      sample.reduce((m, r, i) => {
        const weight = header && i === 0 ? 1.25 : 1;
        return (r[c] ?? '').split(/\r\n|\r|\n/).reduce((w, l) => Math.max(w, l.length * weight), m);
      }, 1),
    );
  }

  // Column widths follow content; then the table is fitted to the page.
  const wanted = longest.map((chars) => Math.max(chars * CHARACTER + PADDING, MIN_COLUMN));
  const sum = (w: number[]) => w.reduce((a, b) => a + b, 0);
  /** Widths that fit `limit`: long columns capped, then any room left goes back to the capped ones. */
  const fit = (limit: number): number[] | null => {
    const w = wanted.map((x) => Math.min(x, MAX_COLUMN));
    const room = limit - sum(w);
    if (room < 0) return null;
    const unmet = wanted.map((x, i) => x - w[i]);
    const need = sum(unmet);
    if (need > 0) for (let i = 0; i < w.length; i++) w[i] += Math.floor(Math.min(room, need) * (unmet[i] / need));
    return w;
  };
  let landscape = false;
  let widths = fit(PORTRAIT);
  if (!widths) {
    landscape = true;
    widths = fit(LANDSCAPE);
  }
  // Still too wide: the page grows to hold the table, as far as Word allows (22 inches), rather than
  // wrapping numbers. It stops being printable at that width, but a sheet is for reading on screen.
  let pageText = LANDSCAPE;
  if (!widths) {
    widths = fit(WIDEST);
    if (widths) pageText = Math.max(sum(widths), LANDSCAPE);
  }
  if (!widths) {
    // Too many columns even for the widest page: wide ones give up width first (their text wraps).
    widths = wanted.map((x) => Math.min(x, MAX_COLUMN));
    pageText = WIDEST;
    let excess = sum(widths) - WIDEST;
    for (const i of widths.map((_, i) => i).sort((x, y) => widths![y] - widths![x])) {
      if (excess <= 0) break;
      const take = Math.min(widths[i] - Math.max(MIN_COLUMN, Math.round(widths[i] * 0.5)), excess);
      widths[i] -= take;
      excess -= take;
    }
    if (sum(widths) > WIDEST) {
      const scale = WIDEST / sum(widths);
      widths = widths.map((w) => Math.max(Math.floor(w * scale), 300));
    }
  }
  widths = widths.map(Math.floor);

  const build = (cells: string[], isHeader: boolean): TableRow => {
    const out: TableCell[] = [];
    for (let c = 0; c < columns; c++) {
      out.push({
        kind: 'cell',
        properties: {
          width: { w: String(widths[c]), type: 'dxa' },
          ...(isHeader ? { shading: { val: 'clear', color: 'auto', fill: 'F2F2F2' } } : {}),
        },
        children: [cellParagraph(cells[c] ?? '', numeric[c], isHeader)],
        attrs: {},
      });
    }
    return { kind: 'row', properties: isHeader ? { header: true, cantSplit: true } : { cantSplit: true }, cells: out, attrs: {} };
  };

  const table: Table = {
    kind: 'table',
    properties: {
      width: { w: '0', type: 'auto' },
      layout: 'fixed',
      borders: { top: HAIRLINE, left: HAIRLINE, bottom: HAIRLINE, right: HAIRLINE, insideH: HAIRLINE, insideV: HAIRLINE },
      cellMargins: { top: { w: '15', type: 'dxa' }, bottom: { w: '15', type: 'dxa' } },
    },
    grid: widths,
    rows: grid.map((r, i) => build(r, header && i === 0)),
  };
  doc.body = [table, { kind: 'paragraph', properties: {}, children: [], attrs: {} }] satisfies Block[];

  // Compact, sheet-like text: 10pt, single-spaced, nothing between paragraphs.
  const run = (doc.styles.defaultRunProperties ??= {});
  run.size = 20;
  run.sizeCs = 20;
  doc.styles.hasRunDefaults = true;
  const paragraph = (doc.styles.defaultParagraphProperties ??= {});
  paragraph.spacing = { ...paragraph.spacing, before: 0, after: 0, line: 240, lineRule: 'auto' };
  doc.styles.hasParagraphDefaults = true;

  const page = (doc.section.pageSize ??= { w: 12240, h: 15840 });
  const margins = (doc.section.margins ??= {});
  margins.left = margins.right = 1440;
  if (landscape) {
    const margin = 1440;
    doc.section.pageSize = { ...page, w: pageText + 2 * margin, h: 12240, orient: 'landscape' };
    margins.left = margins.right = margin;
  }
  return doc;
}

// --- Writing -----------------------------------------------------------------------------------

/** The text of a cell's paragraphs: paragraphs on lines, breaks as newlines, tabs as tabs. */
function cellText(cell: TableCell): string {
  const lines: string[] = [];
  const inline = (inlines: readonly Inline[]): string =>
    inlines
      .map((i) => {
        if (i.kind === 'run') {
          return i.content
            .map((c) => (c.kind === 'text' ? c.text : c.kind === 'tab' ? '\t' : c.kind === 'break' || c.kind === 'cr' ? '\n' : ''))
            .join('');
        }
        if (i.kind === 'hyperlink' || i.kind === 'wrapper') return inline(i.children);
        return '';
      })
      .join('');
  const walk = (blocks: readonly Block[]) => {
    for (const b of blocks) {
      if (b.kind === 'paragraph') lines.push(inline(b.children));
      else if (b.kind === 'wrapper') walk(b.children);
      else if (b.kind === 'table') for (const r of b.rows) if (r.kind === 'row') for (const c of r.cells) if (c.kind === 'cell') lines.push(cellText(c));
    }
  };
  walk(cell.children);
  return lines.join('\n');
}

/** The document as rows: every table's rows in order (a blank row between tables), or a row per non-empty paragraph. */
export function documentToRows(doc: WordDocument): string[][] {
  const rows: string[][] = [];
  const tables: Table[] = [];
  const collect = (blocks: readonly Block[]) => {
    for (const b of blocks) {
      if (b.kind === 'table') tables.push(b);
      else if (b.kind === 'wrapper') collect(b.children);
    }
  };
  collect(doc.body);
  if (tables.length) {
    tables.forEach((table, t) => {
      if (t > 0) rows.push([]);
      for (const row of table.rows) {
        if (row.kind !== 'row') continue;
        const cells: string[] = [];
        for (const cell of row.cells) {
          if (cell.kind !== 'cell') continue;
          cells.push(cellText(cell));
          for (let s = 1; s < (cell.properties.gridSpan ?? 1); s++) cells.push('');
        }
        rows.push(cells);
      }
    });
    return rows;
  }
  const paragraphs = (blocks: readonly Block[]) => {
    for (const b of blocks) {
      if (b.kind === 'paragraph') {
        const text = cellText({ kind: 'cell', properties: {}, children: [b], attrs: {} });
        if (text.trim()) rows.push([text]);
      } else if (b.kind === 'wrapper') paragraphs(b.children);
    }
  };
  paragraphs(doc.body);
  return rows;
}

function quote(field: string, delimiter: string): string {
  if (/["\r\n]/.test(field) || field.includes(delimiter) ) return `"${field.replace(/"/g, '""')}"`;
  return field;
}

export function writeDelimited(rows: string[][], delimiter: string, ext: CsvExtension = {}): Uint8Array {
  const ending = ext.lineEnding ?? '\n';
  let text = rows
    .map((row) => row.map((f) => quote(f, delimiter)).join(delimiter))
    .join(ending);
  // A single empty field would vanish from the file; quoting it keeps the row. That is so for a last row that no
  // line ending follows too (elsewhere its line ending keeps it).
  const last = rows.at(-1);
  if (last?.length === 1 && last[0] === '' && (rows.length === 1 || ext.trailingNewline === false)) text += '""';
  if (rows.length && ext.trailingNewline !== false) text += ending;
  return encodeText(text, ext.encoding ?? 'utf-8', !!ext.bom);
}
