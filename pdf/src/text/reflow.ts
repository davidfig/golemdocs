// Structure recovery: turns a page's positioned text (extractText) into the blocks an editable
// document is made of: paragraphs, headings and list items, in reading order.
//
// Pure and renderer-agnostic; the heuristics are documented next to each step. Coordinates
// inside this file are displayed page coordinates (points from the top-left, y down), so
// "above" means a smaller y and rotated pages are handled by PdfPage.toDisplay.

import type { PdfDocument } from '../document.ts';
import type { PdfPage } from '../page.ts';
import { extractText } from './extract.ts';

export type Align = 'left' | 'center' | 'right';

/** A stretch of text in one style. `size` is in points. */
export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  size: number;
  fontName: string;
  /** RRGGBB; absent for black. */
  color?: string;
}

/** Vertical placement in points: the baseline-to-baseline distance within the block, and the gap above it beyond that. */
export interface Spacing {
  line: number;
  before: number;
}

/** Points: `left` is the whole paragraph's indent from the column edge, `firstLine` extra on line one, `right` from the column's right edge. */
export interface Indent {
  left: number;
  firstLine: number;
  right?: number;
}

export type ListFormat = 'decimal' | 'lowerLetter' | 'upperLetter' | 'lowerRoman' | 'upperRoman';

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; runs: Run[]; align?: Align; indent?: Indent; spacing?: Spacing }
  | { kind: 'paragraph'; runs: Run[]; align?: Align; indent?: Indent; spacing?: Spacing }
  | {
      kind: 'listItem';
      ordered: boolean;
      /** The marker as printed ("•", "3.", "b)"); not part of `runs`. */
      marker: string;
      /** Nesting depth, 0 = outermost. */
      level: number;
      /** Ordered lists: how the marker counts, and the number it shows. */
      format?: ListFormat;
      start?: number;
      runs: Run[];
      /** Where the PDF put the marker (`left` + `firstLine`) and the text (`left`), from the column edge. */
      indent?: Indent;
      spacing?: Spacing;
    }
  /** `page`: the zero-based PDF page that starts here. */
  | { kind: 'pageBreak'; page?: number };

export interface PageMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PageInfo {
  width: number;
  height: number;
  /** Where the page's body text sits (headers and footers excluded), in points. */
  margins: PageMargins;
}

export interface PageBlocks extends PageInfo {
  blocks: Block[];
  /** The most common font size (by characters) on the page. */
  bodySize: number;
}

export interface ReflowOptions {
  /** Emit a pageBreak block wherever a PDF page ended (default false: text flows on). */
  pageBreaks?: boolean;
}

/** A line of a running head or foot: its baseline and size, and the pieces of it that stand apart across the page. */
export interface RunningLine {
  /** Baseline, points from the top of the page. */
  y: number;
  size: number;
  segments: {
    x: number;
    x1: number;
    runs: Run[];
    /** Its text is a page number ("3", "3 of 10", "3/10"). */
    pageNumber?: boolean;
  }[];
}

export interface ReflowResult {
  /** The running heads and feet the pages repeat (taken off the first page that has them; they are not in `blocks`). */
  running?: { header: RunningLine[]; footer: RunningLine[] };
  blocks: Block[];
  /** The PDF page the first block is on (page breaks name the pages after it). */
  firstPage: number;
  pages: PageInfo[];
  bodySize: number;
}

// --- Pieces and rows -----------------------------------------------------------------------

interface Piece {
  /** RRGGBB, unless black. */
  color?: string;
  text: string;
  x: number;
  x1: number;
  y: number;
  size: number;
  bold: boolean;
  italic: boolean;
  fontName: string;
}

/** Pieces sharing a baseline. */
interface Row {
  y: number;
  size: number;
  pieces: Piece[];
  x0: number;
  x1: number;
  chars: number;
  text: string;
}

interface PageRows {
  index: number;
  width: number;
  height: number;
  rows: Row[];
}

const round05 = (n: number) => Math.round(n * 2) / 2;

const BOLD = /bold|black|heavy|demi|[-,]bd|cmbx|cmb\d|extrabd/i;
const ITALIC = /italic|oblique|slanted|[-,]it(?![a-z])|[-,]ital|cmti|cmsl|cmmi|kursiv/i;
const styleCache = new Map<string, [boolean, boolean]>();

function styleOf(fontName: string): [boolean, boolean] {
  let s = styleCache.get(fontName);
  if (!s) {
    s = [BOLD.test(fontName), ITALIC.test(fontName)];
    styleCache.set(fontName, s);
  }
  return s;
}

const LIGATURES: Record<string, string> = {
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  'ﬅ': 'st',
  'ﬆ': 'st',
};

function cleanText(text: string): string {
  return text.replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c]).replace(/[   ]/g, ' ');
}

/** Horizontal, visible-on-page text of one page as pieces in displayed coordinates. */
function readPieces(page: PdfPage): { pieces: Piece[]; width: number; height: number } {
  const { width, height } = page.size;
  const pieces: Piece[] = [];
  for (const it of extractText(page).items) {
    if (!/\S/.test(it.text) || !(it.fontSize > 0)) continue;
    const [px, py] = page.toDisplay(it.x, it.y);
    const [qx, qy] = page.toDisplay(it.x + it.dir[0], it.y + it.dir[1]);
    // Only text that runs left to right across the displayed page (rotated text is skipped).
    if (qx - px < 0.99 || Math.abs(qy - py) > 0.1) continue;
    if (px < -5 || px > width + 5 || py < -5 || py > height + 5) continue; // clipped away
    const [bold, italic] = styleOf(it.fontName);
    pieces.push({
      text: cleanText(it.text),
      x: px,
      x1: px + it.width,
      y: py,
      size: round05(it.fontSize),
      bold,
      italic,
      fontName: it.fontName,
      ...(it.color !== undefined && it.color !== 0 && { color: it.color.toString(16).padStart(6, '0').toUpperCase() }),
    });
  }
  return { pieces, width, height };
}

/** Groups pieces into baselines, top to bottom; superscripts and subscripts stay with their line. */
function buildRows(pieces: Piece[]): Row[] {
  pieces.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Row[] = [];
  let cur: Row | undefined;
  for (const p of pieces) {
    if (cur) {
      const tol = Math.min(0.45 * Math.max(cur.size, p.size), 0.9 * Math.min(cur.size, p.size));
      if (p.y - cur.y <= tol) {
        cur.pieces.push(p);
        if (p.size > cur.size) {
          cur.size = p.size;
          cur.y = p.y;
        }
        continue;
      }
    }
    cur = { y: p.y, size: p.size, pieces: [p], x0: 0, x1: 0, chars: 0, text: '' };
    rows.push(cur);
  }
  for (const row of rows) finishRow(row);
  return rows;
}

function finishRow(row: Row): void {
  row.pieces.sort((a, b) => a.x - b.x);
  // Fake bold: the same text drawn twice a hair apart.
  const kept: Piece[] = [];
  for (const p of row.pieces) {
    const q = kept[kept.length - 1];
    // (Two of the same narrow letter in a row, the "ll" of "All", sit a letter's width apart: that is not it.)
    if (q && q.text === p.text && Math.abs(p.x - q.x) < Math.min(0.12 * p.size, 0.5 * (q.x1 - q.x)) && Math.abs(p.y - q.y) < 0.25 * p.size) {
      q.bold = true;
      continue;
    }
    kept.push(p);
  }
  row.pieces = kept;
  measureRow(row);
}

function measureRow(row: Row): void {
  row.x0 = Infinity;
  row.x1 = -Infinity;
  for (const p of row.pieces) {
    row.x0 = Math.min(row.x0, p.x);
    row.x1 = Math.max(row.x1, p.x1);
  }
  const runs = makeRuns(row.pieces);
  row.text = runs.map((r) => r.text).join('');
  row.chars = row.text.length;
  row.size = dominantSize(row.pieces);
}

/** The size most characters are set in. */
function dominantSize(pieces: Piece[]): number {
  if (pieces.length === 1) return pieces[0].size;
  const weight = new Map<number, number>();
  for (const p of pieces) weight.set(p.size, (weight.get(p.size) ?? 0) + p.text.length);
  let best = pieces[0].size;
  let max = -1;
  for (const [size, w] of weight) {
    if (w > max || (w === max && size > best)) {
      best = size;
      max = w;
    }
  }
  return best;
}

/** Pieces to runs: adjacent pieces of one style merge; a gap wider than a word space becomes a space. */
function makeRuns(pieces: Piece[]): Run[] {
  const runs: Run[] = [];
  let prev: Piece | undefined;
  for (const p of pieces) {
    if (prev && runs.length) {
      const gap = p.x - prev.x1;
      const last = runs[runs.length - 1];
      if (gap > 0.16 * Math.max(prev.size, p.size) && !/\s$/.test(last.text) && !/^\s/.test(p.text)) last.text += ' ';
    }
    const last = runs[runs.length - 1];
    if (last && last.bold === p.bold && last.italic === p.italic && last.size === p.size && last.fontName === p.fontName && last.color === p.color) {
      last.text += p.text;
    } else {
      runs.push({ text: p.text, bold: p.bold, italic: p.italic, size: p.size, fontName: p.fontName, ...(p.color && { color: p.color }) });
    }
    prev = p;
  }
  for (const r of runs) r.text = r.text.replace(/\s+/g, ' ');
  return trimRuns(runs);
}

function trimRuns(runs: Run[]): Run[] {
  while (runs.length && !runs[0].text.trimStart()) runs.shift();
  while (runs.length && !runs[runs.length - 1].text.trimEnd()) runs.pop();
  if (runs.length) {
    runs[0].text = runs[0].text.trimStart();
    runs[runs.length - 1].text = runs[runs.length - 1].text.trimEnd();
  }
  return runs;
}

// --- Headers, footers and page numbers -----------------------------------------------------

const BAND = 0.1; // top and bottom tenth of the page
const PAGE_NUMBER = /^(?:page\s*)?[-–—\s]*(?:\d{1,4}|[ivxlcdm]{1,6})[-–—\s]*(?:(?:of|\/)\s*\d{1,4})?$/i;

function inBand(row: Row, height: number): boolean {
  return row.y < BAND * height || row.y > (1 - BAND) * height;
}

/**
 * Removes rows that recur at the same height on several pages (running heads, footers, page
 * numbers: digits are ignored when comparing) and lone page numbers in the top/bottom tenth.
 */
function dropRunningText(pages: PageRows[]): { header: RunningLine[]; footer: RunningLine[] } {
  const groups = new Map<string, { page: number; row: Row }[]>();
  for (const page of pages) {
    for (const row of page.rows) {
      if (!inBand(row, page.height)) continue;
      const key = row.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push({ page: page.index, row });
    }
  }
  const need = Math.min(3, Math.max(2, Math.ceil(0.4 * pages.length)));
  const doomed = new Set<Row>();
  if (pages.length > 1) {
    for (const g of groups.values()) {
      if (g.length < need) continue;
      g.sort((a, b) => a.row.y - b.row.y);
      let start = 0;
      for (let i = 1; i <= g.length; i++) {
        if (i < g.length && g[i].row.y - g[i - 1].row.y <= 3) continue;
        const cluster = g.slice(start, i);
        if (new Set(cluster.map((c) => c.page)).size >= need) for (const c of cluster) doomed.add(c.row);
        start = i;
      }
    }
  }
  const running: { header: RunningLine[]; footer: RunningLine[] } = { header: [], footer: [] };
  for (const page of pages) {
    const gone = page.rows.filter((row) => doomed.has(row) || (inBand(row, page.height) && PAGE_NUMBER.test(row.text.trim())));
    page.rows = page.rows.filter((row) => !gone.includes(row));
    // The lines are taken from the first page that has some.
    if (gone.length && !running.header.length && !running.footer.length) for (const row of gone) (row.y < page.height / 2 ? running.header : running.footer).push(runningLine(row));
  }
  // A mark a hair off its line's baseline (a bullet after a title) is a part of that line.
  for (const lines of [running.header, running.footer]) {
    lines.sort((a, b) => a.y - b.y);
    for (let i = lines.length - 1; i > 0; i--) {
      if (lines[i].y - lines[i - 1].y < 0.6 * Math.max(lines[i].size, lines[i - 1].size)) {
        lines[i - 1].segments.push(...lines[i].segments);
        lines[i - 1].segments.sort((a, b) => a.x - b.x);
        lines.splice(i, 1);
      }
    }
  }
  return running;
}

/** A row as a running line: pieces more than a letter or two apart are separate segments (a date at the left, a title in the middle). */
function runningLine(row: Row): RunningLine {
  const segments: RunningLine['segments'] = [];
  let group: Piece[] = [];
  const close = () => {
    if (!group.length) return;
    const runs = makeRuns(group);
    const text = runs.map((r) => r.text).join('').trim();
    segments.push({ x: group[0].x, x1: Math.max(...group.map((p) => p.x1)), runs, ...(/\d/.test(text) && PAGE_NUMBER.test(text) ? { pageNumber: true } : {}) });
    group = [];
  };
  for (const p of [...row.pieces].sort((a, b) => a.x - b.x)) {
    const last = group[group.length - 1];
    if (last && p.x - last.x1 > 2.5 * Math.max(last.size, p.size)) close();
    group.push(p);
  }
  close();
  return { y: row.y, size: row.size, segments };
}

// --- Columns ---------------------------------------------------------------------------------

/**
 * Gutters between text columns as [left, right] x ranges: bands that (nearly) no row crosses,
 * wide enough to be a gutter and with real text on both sides. Rows that do cross a gutter
 * (titles, full-width paragraphs) are handled by layoutLines as spanning rows.
 */
function findGutters(rows: Row[], body: number): [number, number][] {
  if (rows.length < 6) return [];
  let minX = Infinity;
  let maxX = -Infinity;
  for (const r of rows) {
    minX = Math.min(minX, r.x0);
    maxX = Math.max(maxX, r.x1);
  }
  const nb = Math.ceil(maxX - minX) + 1;
  if (!(nb > 0) || nb > 6000) return [];
  const count = new Uint16Array(nb + 1);
  const seen = new Int32Array(nb + 1).fill(-1);
  rows.forEach((row, ri) => {
    for (const p of row.pieces) {
      const a = Math.max(0, Math.floor(p.x - minX));
      const b = Math.min(nb, Math.ceil(p.x1 - minX));
      for (let k = a; k < b; k++) {
        if (seen[k] !== ri) {
          seen[k] = ri;
          count[k]++;
        }
      }
    }
  });
  const tolerance = Math.floor(0.08 * rows.length);
  const minGutter = Math.max(6, 0.6 * body);
  let gutters: [number, number][] = [];
  for (let k = 0; k < nb; ) {
    if (count[k] > tolerance) {
      k++;
      continue;
    }
    let e = k;
    while (e < nb && count[e] <= tolerance) e++;
    if (k > 0 && e < nb && e - k >= minGutter) gutters.push([minX + k, minX + e]);
    k = e;
  }
  // Every column needs a real width and a real amount of text, or its gutter isn't one.
  for (let changed = gutters.length > 0; changed; ) {
    changed = false;
    const edges = [minX, ...gutters.flatMap((g) => g), maxX];
    const cols = gutters.length + 1;
    const chars = new Array<number>(cols).fill(0);
    const lines = new Array<number>(cols).fill(0);
    for (const row of rows) {
      const hit = new Set<number>();
      for (const p of row.pieces) {
        const c = columnOf(gutters, (p.x + p.x1) / 2);
        chars[c] += p.text.length;
        hit.add(c);
      }
      for (const c of hit) lines[c]++;
    }
    for (let c = 0; c < cols; c++) {
      const width = edges[2 * c + 1] - edges[2 * c];
      if (width < 5 * body || chars[c] < 40 || lines[c] < 3) {
        gutters = gutters.filter((_, i) => i !== (c < gutters.length ? c : c - 1));
        changed = true;
        break;
      }
    }
  }
  return gutters;
}

function columnOf(gutters: [number, number][], x: number): number {
  let c = 0;
  while (c < gutters.length && (gutters[c][0] + gutters[c][1]) / 2 < x) c++;
  return c;
}

// --- Lines -------------------------------------------------------------------------------------

interface Line {
  pieces: Piece[];
  runs: Run[];
  text: string;
  x0: number;
  x1: number;
  y: number;
  size: number;
  boldAll: boolean;
  page: number;
  /** Lines of one flow follow each other directly (a column of a zone, or consecutive full-width lines). */
  flow: number;
  colLeft: number;
  colRight: number;
  col: number;
}

function makeLine(pieces: Piece[], page: number, flow: number, col: number): Line {
  const runs = makeRuns(pieces);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y = 0;
  let size = 0;
  for (const p of pieces) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x1);
    if (p.size >= size) {
      size = Math.max(size, p.size);
      y = p.y;
    }
  }
  const dom = dominantSize(pieces);
  return {
    pieces,
    runs,
    text: runs.map((r) => r.text).join(''),
    x0,
    x1,
    y,
    size: dom,
    boldAll: runs.length > 0 && runs.every((r) => r.bold || !r.text.trim()),
    page,
    flow,
    colLeft: x0,
    colRight: x1,
    col,
  };
}

/** A page's lines in reading order: zone by zone, column by column. */
function layoutLines(page: PageRows, body: number, nextFlow: () => number): Line[] {
  const gutters = findGutters(page.rows, body);
  const out: Line[] = [];
  const cols = gutters.length + 1;
  const crosses = (row: Row) =>
    gutters.some(([a, b]) => row.pieces.some((p) => p.x < b - 0.5 && p.x1 > a + 0.5));
  let zone: Row[] = [];
  let spanFlow = -1;
  const flush = () => {
    if (!zone.length) return;
    for (let c = 0; c < cols; c++) {
      let flow = -1;
      for (const row of zone) {
        const pieces = row.pieces.filter((p) => columnOf(gutters, (p.x + p.x1) / 2) === c);
        if (!pieces.length) continue;
        if (flow < 0) flow = nextFlow();
        out.push(makeLine(pieces, page.index, flow, c));
      }
    }
    zone = [];
    spanFlow = -1;
  };
  spanFlow = nextFlow();
  for (const row of page.rows) {
    if (gutters.length && !crosses(row)) {
      zone.push(row);
    } else {
      if (zone.length) {
        flush();
        spanFlow = nextFlow();
      }
      if (spanFlow < 0) spanFlow = nextFlow();
      out.push(makeLine(row.pieces, page.index, spanFlow, -1));
    }
  }
  flush();
  // Column edges: from the substantial lines of each column (or the page for full-width lines).
  const bounds = new Map<number, [number, number]>();
  const collect = (key: number, pred: (l: Line) => boolean) => {
    let lines = out.filter((l) => (key < 0 ? true : l.col === key) && pred(l));
    if (!lines.length) lines = out.filter((l) => (key < 0 ? true : l.col === key));
    if (lines.length) bounds.set(key, [Math.min(...lines.map((l) => l.x0)), Math.max(...lines.map((l) => l.x1))]);
  };
  const substantial = (l: Line) => l.text.length >= 25;
  collect(-1, substantial);
  for (let c = 0; c < cols; c++) collect(c, substantial);
  for (const l of out) {
    const b = bounds.get(l.col) ?? bounds.get(-1);
    if (b) {
      l.colLeft = b[0];
      l.colRight = b[1];
    }
  }
  return out;
}

// --- Markers -------------------------------------------------------------------------------------

interface Marker {
  /** Characters the marker occupies at the start of the line text, trailing space included. */
  length: number;
  text: string;
  ordered: boolean;
  /** The values an alphabetic marker could count as (a letter or a roman numeral). */
  candidates: { n: number; format: ListFormat }[];
}

const BULLET_SYMBOL = /^([•●◦○▪▫■□◆◇➢➤►‣⁃∙-])\s*(?=\S)/;
const BULLET_DASH = /^([-–—*·])\s+(?=\S)/;
const NUMBER = /^(\(?(\d{1,2})[.)])\s+(?=\S)/;
const ALPHA = /^(\(?([A-Za-z])[.)])\s+(?=\S)/;
const ROMAN = /^(\(?((?=[ivxlcdm])m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})|(?=[IVXLCDM])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))[.)])\s+(?=\S)/;

const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

function romanValue(s: string): number {
  let total = 0;
  const v = [...s.toLowerCase()].map((c) => ROMAN_VALUES[c]);
  for (let i = 0; i < v.length; i++) total += v[i] < (v[i + 1] ?? 0) ? -v[i] : v[i];
  return total;
}

function parseMarker(text: string): Marker | undefined {
  let m = BULLET_SYMBOL.exec(text) ?? BULLET_DASH.exec(text);
  if (m) return { length: m[0].length, text: m[1], ordered: false, candidates: [] };
  m = NUMBER.exec(text);
  if (m) return { length: m[0].length, text: m[1], ordered: true, candidates: [{ n: Number(m[2]), format: 'decimal' }] };
  const candidates: Marker['candidates'] = [];
  const a = ALPHA.exec(text);
  const r = ROMAN.exec(text);
  const hit = a ?? r;
  if (!hit) return undefined;
  if (a) {
    const lower = a[2] === a[2].toLowerCase();
    candidates.push({ n: a[2].toLowerCase().charCodeAt(0) - 96, format: lower ? 'lowerLetter' : 'upperLetter' });
  }
  if (r) {
    const core = r[2];
    candidates.push({ n: romanValue(core), format: core === core.toLowerCase() ? 'lowerRoman' : 'upperRoman' });
  }
  return { length: hit[0].length, text: hit[1], ordered: true, candidates };
}

/** Markers per line; letters and roman numerals only count when they form a sequence (a. b. c.). */
function findMarkers(lines: Line[], headingSize: (size: number) => boolean): (Marker | undefined)[] {
  const markers = lines.map((l) => (headingSize(l.size) ? undefined : parseMarker(l.text)));
  let prev: { i: number } | undefined;
  const valid = new Set<number>();
  const chosen = new Map<number, ListFormat>();
  lines.forEach((line, i) => {
    const m = markers[i];
    if (!m || !m.candidates.length || m.candidates[0].format === 'decimal') return;
    if (prev && lines[prev.i].flow === line.flow) {
      const p = markers[prev.i]!;
      for (const c of m.candidates) {
        if (p.candidates.some((q) => q.format === c.format && q.n + 1 === c.n)) {
          valid.add(prev.i).add(i);
          chosen.set(i, c.format);
          if (!chosen.has(prev.i)) chosen.set(prev.i, c.format);
        }
      }
    }
    prev = { i };
  });
  return markers.map((m, i) => {
    if (!m || !m.candidates.length || m.candidates[0].format === 'decimal') return m;
    if (!valid.has(i)) return undefined;
    const format = chosen.get(i)!;
    return { ...m, candidates: m.candidates.filter((c) => c.format === format) };
  });
}

/** x where the text after a marker begins. */
function textStart(line: Line, marker: Marker): number {
  let remaining = marker.text.replace(/\s/g, '').length;
  for (let i = 0; i < line.pieces.length; i++) {
    const p = line.pieces[i];
    const chars = [...p.text];
    const nonSpace = chars.filter((c) => /\S/.test(c)).length;
    if (remaining > nonSpace) {
      remaining -= nonSpace;
      continue;
    }
    if (remaining === nonSpace) return line.pieces[i + 1]?.x ?? p.x1;
    let seen = 0;
    let idx = 0;
    for (; idx < chars.length; idx++) {
      if (/\S/.test(chars[idx])) seen++;
      if (seen > remaining) break;
    }
    return p.x + ((p.x1 - p.x) * idx) / Math.max(1, chars.length);
  }
  return line.x0;
}

/** Drops `count` characters from the start of the runs (a marker), and the space after it. */
function stripPrefix(runs: Run[], count: number): Run[] {
  const out = runs.map((r) => ({ ...r }));
  let left = count;
  for (const r of out) {
    const cut = Math.min(left, r.text.length);
    r.text = r.text.slice(cut);
    left -= cut;
    if (left === 0) break;
  }
  return trimRuns(out.filter((r) => r.text.length > 0));
}

// --- Paragraphs ----------------------------------------------------------------------------------

interface Draft {
  lines: Line[];
  runs: Run[];
  list?: { marker: Marker; x: number; textX: number };
  /** Baseline distance of the first two lines, once known. */
  leading?: number;
}

const cloneRuns = (runs: Run[]): Run[] => runs.map((r) => ({ ...r }));

/** Adds a line's runs to a draft, dehyphenating a hyphenated line end. */
function appendLine(d: Draft, runs: Run[]): void {
  runs = cloneRuns(runs);
  const last = d.runs[d.runs.length - 1];
  if (!last || !runs.length) {
    d.runs.push(...runs);
    return;
  }
  const m = /([\p{L}\p{N}])([-‐­])$/u.exec(last.text);
  if (m) {
    const first = runs[0].text[0] ?? '';
    if (m[2] === '­' || (/\p{Ll}/u.test(first) && /\p{L}/u.test(m[1]))) last.text = last.text.slice(0, -1);
    else if (m[2] === '‐') last.text = last.text.slice(0, -1) + '-';
  } else if (!/\s$/.test(last.text)) {
    last.text += ' ';
  }
  d.runs.push(...runs);
}

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const p = out[out.length - 1];
    if (p && p.bold === r.bold && p.italic === r.italic && p.size === r.size && p.fontName === r.fontName && p.color === r.color) p.text += r.text;
    else out.push({ ...r });
  }
  return trimRuns(out.filter((r) => r.text.length > 0));
}

const centered = (l: Line): boolean => {
  const w = l.colRight - l.colLeft;
  if (w < 10 * l.size) return false;
  const margin = Math.max(1.5 * l.size, 0.06 * w);
  return (
    Math.abs((l.x0 + l.x1) / 2 - (l.colLeft + l.colRight) / 2) <= Math.max(2, 0.02 * w) &&
    l.x0 - l.colLeft > margin &&
    l.colRight - l.x1 > margin
  );
};

const rightAligned = (l: Line): boolean => {
  const w = l.colRight - l.colLeft;
  return w >= 10 * l.size && Math.abs(l.colRight - l.x1) <= Math.max(2, 0.02 * w) && l.x0 - l.colLeft > 0.15 * w;
};

interface Stats {
  body: number;
  leading: number;
  isHeadingSize: (size: number) => boolean;
}

const YEAR_START = /^(19|20)\d{2}(?!\d)/;

/** Whether `line` continues the paragraph being built, given they follow each other in one flow. */
function continues(d: Draft, line: Line, marker: Marker | undefined, stats: Stats): boolean {
  const pv = d.lines[d.lines.length - 1];
  if (marker) return false;
  if (Math.abs(line.size - pv.size) > 0.12 * pv.size + 0.3) return false;
  if (line.boldAll !== pv.boldAll) return false;
  if (centered(line) !== centered(pv) || rightAligned(line) !== rightAligned(pv)) return false;
  // Entries that each start with a year (a CV's exhibitions) are separate items, however long the lines.
  if (YEAR_START.test(line.text) && YEAR_START.test(d.lines[0].text)) return false;
  const gap = line.y - pv.y;
  const leading = d.leading ?? stats.leading * (line.size / stats.body);
  if (gap > 1.35 * leading + 0.5 || gap < 0.3 * line.size) return false;
  const width = line.colRight - line.colLeft;
  const heading = stats.isHeadingSize(line.size);
  if (!heading && !centered(line) && width > 8 * line.size && pv.x1 < line.colRight - 0.4 * width) return false;
  if (line.x0 - pv.x0 > 0.9 * line.size) {
    if (d.list) return Math.abs(line.x0 - d.list.textX) <= 0.8 * line.size;
    // A hanging indent (item text wrapping under an indented margin) versus a new first-line indent.
    return d.lines.length === 1 && pv.x1 >= line.colRight - 0.4 * width && !centered(line);
  }
  return true;
}

/** Whether a paragraph that ended a column or page carries on at the top of the next one. */
function carriesOver(d: Draft, line: Line, marker: Marker | undefined, stats: Stats): boolean {
  const pv = d.lines[d.lines.length - 1];
  if (marker || stats.isHeadingSize(line.size) || stats.isHeadingSize(pv.size)) return false;
  if (Math.abs(line.size - pv.size) > 0.12 * pv.size + 0.3 || line.boldAll !== pv.boldAll) return false;
  if (line.x0 - line.colLeft > 0.9 * line.size || centered(line) || centered(pv)) return false;
  const width = pv.colRight - pv.colLeft;
  if (pv.x1 < pv.colRight - 0.25 * width) return false;
  if (/[.!?:;"”)\]]$/.test(pv.text) && !/-$/.test(pv.text)) return false;
  return /^\p{Ll}/u.test(line.text) || /[-‐­]$/.test(pv.text);
}

type Pending =
  | { kind: 'break'; page: number }
  | { kind: 'text'; d: Draft; size: number }
  | { kind: 'list'; d: Draft; size: number };

function buildDrafts(lines: Line[], stats: Stats, markers: (Marker | undefined)[], pageBreaks: boolean): Pending[] {
  const out: Pending[] = [];
  let cur: Draft | undefined;
  const close = () => {
    if (cur) {
      const size = dominantOfLines(cur.lines);
      out.push(cur.list ? { kind: 'list', d: cur, size } : { kind: 'text', d: cur, size });
      cur = undefined;
    }
  };
  lines.forEach((line, i) => {
    const marker = markers[i];
    const pv = cur?.lines[cur.lines.length - 1];
    let join = false;
    if (cur && pv) {
      if (pageBreaks && pv.page !== line.page) {
        close();
        out.push({ kind: 'break', page: line.page });
      } else if (pv.flow === line.flow) join = continues(cur, line, marker, stats);
      else join = carriesOver(cur, line, marker, stats);
    }
    if (join && cur && pv) {
      if (cur.leading === undefined && cur.lines.length === 1 && pv.flow === line.flow) cur.leading = line.y - pv.y;
      cur.lines.push(line);
      appendLine(cur, line.runs);
      return;
    }
    close();
    cur = { lines: [line], runs: [] };
    if (marker) {
      cur.list = { marker, x: line.x0, textX: textStart(line, marker) };
      appendLine(cur, stripPrefix(line.runs, marker.length));
    } else {
      appendLine(cur, line.runs);
    }
  });
  close();
  return out;
}

function dominantOfLines(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const l of lines) weight.set(l.size, (weight.get(l.size) ?? 0) + l.text.length);
  let best = lines[0].size;
  let max = -1;
  for (const [size, w] of weight) {
    if (w > max) {
      best = size;
      max = w;
    }
  }
  return best;
}

/**
 * Lines centered on a point that isn't their column's middle (a title beside a picture, say):
 * centered in a box that runs from the column's left edge to the same distance past that point.
 */
function offCenter(lines: Line[]): Indent | undefined {
  if (lines.length < 2) return undefined;
  const c = (lines[0].x0 + lines[0].x1) / 2;
  if (!lines.every((l) => Math.abs((l.x0 + l.x1) / 2 - c) <= 2 && l.colLeft === lines[0].colLeft && l.colRight === lines[0].colRight)) return undefined;
  const { colLeft, colRight } = lines[0];
  const right = colRight - (2 * c - colLeft);
  const widest = Math.max(...lines.map((l) => l.x1 - l.x0));
  // Only a box that holds every line, and is clearly narrower than the column.
  if (right < 0.1 * (colRight - colLeft) || 2 * c - 2 * colLeft < widest) return undefined;
  return { left: 0, firstLine: 0, right: round1(right) };
}

/** The runs of lines that keep their own lines (a title of several lines): one run per style, '\n' between lines. */
function runsByLine(lines: Line[]): Run[] {
  const out: Run[] = [];
  lines.forEach((l, i) => {
    const runs = cloneRuns(l.runs);
    if (i < lines.length - 1 && runs.length) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '') + '\n';
    out.push(...runs);
  });
  return out;
}

function alignOf(lines: Line[]): Align | undefined {
  if (lines.every(centered)) return 'center';
  if (lines.every(rightAligned)) return 'right';
  return undefined;
}

/** How far down a line's box its baseline is, as a share of the box (Word's, with an exact line height). */
const ASCENT_SHARE = 0.78;

const round1 = (n: number) => Math.round(n * 10) / 10;

function indentOf(lines: Line[], size: number): Indent | undefined {
  const rest = lines.length > 1 ? Math.min(...lines.slice(1).map((l) => l.x0)) : lines[0].x0;
  const left = rest - lines[0].colLeft;
  const firstLine = lines.length > 1 ? lines[0].x0 - rest : 0;
  if (left < Math.max(1.5, 0.5 * size) && Math.abs(firstLine) < Math.max(1.5, 0.5 * size)) return undefined;
  return { left: round1(Math.max(0, left)), firstLine: round1(firstLine) };
}

// --- Assembly ----------------------------------------------------------------------------------

/** Most common size by characters. */
function bodySizeOf(pages: PageRows[]): number {
  const weight = new Map<number, number>();
  for (const page of pages) {
    for (const row of page.rows) for (const p of row.pieces) weight.set(p.size, (weight.get(p.size) ?? 0) + p.text.length);
  }
  let best = 10;
  let max = -1;
  for (const [size, w] of weight) {
    if (w > max || (w === max && size < best)) {
      best = size;
      max = w;
    }
  }
  return best;
}

function median(values: number[], fallback: number): number {
  if (!values.length) return fallback;
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

function pageMargins(page: PageRows): PageMargins {
  const rows = page.rows;
  if (!rows.length) return { top: 72, right: 72, bottom: 72, left: 72 };
  const solid = rows.filter((r) => r.chars >= 20);
  const use = solid.length ? solid : rows;
  const left = Math.min(...use.map((r) => r.x0));
  const right = page.width - Math.max(...use.map((r) => r.x1));
  const top = rows[0].y - 0.8 * rows[0].size;
  const bottom = page.height - (rows[rows.length - 1].y + 0.25 * rows[rows.length - 1].size);
  const clamp = (n: number) => Math.max(0, round1(n));
  return { top: clamp(top), right: clamp(right), bottom: clamp(bottom), left: clamp(left) };
}

function assemble(pages: PageRows[], options: ReflowOptions): ReflowResult {
  const body = bodySizeOf(pages);
  let flowId = 0;
  const nextFlow = () => flowId++;
  const lines: Line[] = [];
  for (const page of pages) lines.push(...layoutLines(page, body, nextFlow));

  // Typical baseline distance of body text within a flow.
  const gaps: number[] = [];
  let boldChars = 0;
  let bodyChars = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.size === body) {
      bodyChars += l.text.length;
      if (l.boldAll) boldChars += l.text.length;
    }
    const p = lines[i - 1];
    if (p && p.flow === l.flow && p.size === body && l.size === body && l.y - p.y > 0.9 * body && l.y - p.y < 2 * body) gaps.push(l.y - p.y);
  }
  const leading = median(gaps, 1.2 * body);
  const isHeadingSize = (size: number) => size >= body * 1.12 && size - body >= 1;
  const stats: Stats = { body, leading, isHeadingSize };
  const pending = buildDrafts(lines, stats, findMarkers(lines, isHeadingSize), options.pageBreaks === true);

  // Heading levels: the distinct heading sizes, largest first.
  const bodyBold = bodyChars > 0 && boldChars / bodyChars > 0.5;
  const headingSizes = new Set<number>();
  const isHeading = (p: Pending & { kind: 'text' }) => {
    const chars = p.d.lines.reduce((n, l) => n + l.text.length, 0);
    return isHeadingSize(p.size) && p.d.lines.length <= 4 && chars <= 300;
  };
  for (const p of pending) if (p.kind === 'text' && isHeading(p)) headingSizes.add(p.size);
  const sizes = [...headingSizes].sort((a, b) => b - a);
  const boldHeadingLevel = Math.min(4, sizes.length + 1) as 1 | 2 | 3 | 4;
  const levelOf = (size: number) => Math.min(4, sizes.indexOf(size) + 1) as 1 | 2 | 3 | 4;

  const blocks: Block[] = [];
  const lists: { x: number; size: number; block: Block }[][] = [];
  let run: { x: number; size: number; block: Block }[] | undefined;
  let previous: Line | undefined;
  let previousPitch = 0;
  /** Per page: where the first block's box starts, if that is above where its text sits. */
  const tops = new Map<number, number>();
  /** Where a block sits vertically: its own line pitch, and the gap left above it by the block before. */
  const spacingOf = (lines: Line[], size: number): Spacing => {
    const gaps: number[] = [];
    for (let i = 1; i < lines.length; i++) if (lines[i].flow === lines[i - 1].flow && lines[i].y > lines[i - 1].y) gaps.push(lines[i].y - lines[i - 1].y);
    const natural = Math.abs(size - body) < 0.5 ? leading : size * 1.2;
    const line = Math.min(Math.max(gaps.length ? median(gaps, natural) : natural, 0.9 * size), 3 * size);
    const first = lines[0];
    // A line's baseline sits about 78% of the way down its box: the box above it is what this
    // block needs, the rest of the previous block's last box is what it leaves below.
    const above = ASCENT_SHARE * line;
    const before =
      previous && previous.page === first.page
        ? first.y > previous.y ? first.y - previous.y - above - (1 - ASCENT_SHARE) * previousPitch : 0
        : first.y - above - (tops.set(first.page, Math.min(tops.get(first.page) ?? pageMargins(pages[first.page]).top, first.y - above)), tops.get(first.page)!);
    previousPitch = line;
    return { line: round1(line), before: round1(Math.max(0, before)) };
  };
  for (const p of pending) {
    if (p.kind === 'break') {
      blocks.push({ kind: 'pageBreak', page: p.page });
      run = undefined;
      previous = undefined;
      continue;
    }
    let runs = mergeRuns(p.d.runs);
    if (!runs.length) continue;
    const spacing = spacingOf(p.d.lines, p.size);
    previous = p.d.lines[p.d.lines.length - 1];
    const align = alignOf(p.d.lines);
    if (p.kind === 'list') {
      const m = p.d.list!.marker;
      const first = m.candidates[0];
      const { x, textX } = p.d.list!;
      const left = Math.max(0, textX - p.d.lines[0].colLeft);
      const hang = Math.max(0, Math.min(left, textX - x));
      const block: Block = {
        kind: 'listItem',
        ordered: m.ordered,
        marker: m.text,
        level: 0,
        ...(first ? { format: first.format, start: first.n } : {}),
        runs,
        indent: { left: round1(left), firstLine: -round1(hang) },
        spacing,
      };
      blocks.push(block);
      if (!run) lists.push((run = []));
      run.push({ x: p.d.list!.x, size: p.size, block });
      continue;
    }
    run = undefined;
    const text = runs.map((r) => r.text).join('');
    const lineCount = p.d.lines.length;
    if (isHeading(p)) {
      const box = align ? undefined : offCenter(p.d.lines);
      // A title keeps the line breaks the PDF set it with: another font's widths would break it somewhere else.
      if (box || lineCount > 1) runs = mergeRuns(runsByLine(p.d.lines));
      blocks.push({ kind: 'heading', level: levelOf(p.size), runs, ...(align || box ? { align: align ?? 'center' } : {}), ...(box ? { indent: box } : {}) });
    } else if (
      !bodyBold &&
      lineCount <= 2 &&
      text.length <= 120 &&
      p.d.lines.every((l) => l.boldAll) &&
      !/[,;]$/.test(text) &&
      /\p{L}/u.test(text)
    ) {
      const box = align ? undefined : offCenter(p.d.lines);
      if (box || lineCount > 1) runs = mergeRuns(runsByLine(p.d.lines));
      blocks.push({ kind: 'heading', level: boldHeadingLevel, runs, ...(align || box ? { align: align ?? 'center' } : {}), ...(box ? { indent: box } : {}) });
    } else {
      const box = align ? undefined : offCenter(p.d.lines);
      if (box) runs = mergeRuns(runsByLine(p.d.lines));
      const indent = align || box ? box : indentOf(p.d.lines, p.size);
      // A block set well in from the column's edge (an address beside a picture) keeps its own lines.
      const width = p.d.lines[0].colRight - p.d.lines[0].colLeft;
      if (!box && indent && indent.firstLine === 0 && indent.left > 0.15 * width && p.d.lines.length > 1) runs = mergeRuns(runsByLine(p.d.lines));
      blocks.push({ kind: 'paragraph', runs, ...(align || box ? { align: align ?? 'center' } : {}), ...(indent ? { indent } : {}) });
    }
    const made = blocks[blocks.length - 1];
    if (made.kind !== 'pageBreak') made.spacing = spacing;
  }
  assignListLevels(lists);

  return {
    blocks,
    firstPage: lines[0]?.page ?? 0,
    pages: pages.map((p, i) => {
      const margins = pageMargins(p);
      return { width: p.width, height: p.height, margins: { ...margins, top: Math.min(margins.top, tops.get(i) ?? margins.top) } };
    }),
    bodySize: body,
  };
}

/** Nesting from marker positions: within a run of list items, deeper markers are deeper levels. */
function assignListLevels(lists: { x: number; size: number; block: Block }[][]): void {
  for (const items of lists) {
    const base = Math.min(...items.map((i) => i.x));
    for (const item of items) {
      const step = Math.max(12, item.size * 1.3);
      if (item.block.kind === 'listItem') item.block.level = Math.min(3, Math.floor((item.x - base) / step + 0.5));
    }
  }
}

// --- Public API ------------------------------------------------------------------------------------

function readPage(page: PdfPage, index: number): PageRows {
  const { pieces, width, height } = readPieces(page);
  return { index, width, height, rows: buildRows(pieces) };
}

/** Reflows one page. Repeated headers and footers need several pages: see reflowDocument. */
export function reflowPage(page: PdfPage, options: ReflowOptions = {}): PageBlocks {
  const rows = readPage(page, 0);
  dropRunningText([rows]);
  const result = assemble([rows], options);
  return { ...result.pages[0], blocks: result.blocks, bodySize: result.bodySize };
}

/** Reflows a whole document, dropping running heads, footers and page numbers, and joining paragraphs across columns and pages. */
export function analyzeDocument(doc: PdfDocument, options: ReflowOptions = {}): ReflowResult {
  const pages = doc.pages.map((page, i) => readPage(page, i));
  const running = dropRunningText(pages);
  const result = assemble(pages, options);
  return running.header.length || running.footer.length ? { ...result, running } : result;
}

export function reflowDocument(doc: PdfDocument, options: ReflowOptions = {}): Block[] {
  return analyzeDocument(doc, options).blocks;
}
