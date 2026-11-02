// Printing a sheet (docs/spreadsheets.md, M6): its page setup as Excel keeps it (`<pageSetup>`, `<pageMargins>`,
// `<printOptions>`, `<headerFooter>`, `<rowBreaks>`/`<colBreaks>`, `fitToPage`, and the `_xlnm.Print_Area` and
// `_xlnm.Print_Titles` names), and its pages: the print area (or the cells in use) cut into pages of the paper less its
// margins, at the scale asked for or the one that fits it to so many pages, at the manual breaks, the title rows and
// columns repeated on each, in Excel's order (down, then over). sheetPdf.ts draws the pages.

import { el, elements } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import type { DefinedName, Workbook } from './model/workbook.ts';
import type { CellRange, Worksheet } from './model/worksheet.ts';
import { Kind } from './model/column.ts';
import { parseRange, rangeName } from './refs.ts';

/** Paper sizes in points (width, height), by Excel's `paperSize` numbers (the common ones; others print on Letter). */
export const PAPER: Record<number, [number, number]> = {
  1: [612, 792], // Letter
  3: [792, 1224], // Tabloid
  5: [612, 1008], // Legal
  7: [522, 756], // Executive
  8: [842, 1191], // A3
  9: [595, 842], // A4
  11: [420, 595], // A5
  12: [729, 1032], // B4 (JIS)
  13: [516, 729], // B5 (JIS)
  20: [297, 684], // Envelope #10
  27: [312, 624], // Envelope DL
};

export interface PageSetup {
  orientation: 'portrait' | 'landscape';
  paperSize: number;
  /** Percent, 10 to 400. */
  scale: number;
  /** Fit to so many pages wide and tall (0: as many as it takes), instead of the scale. */
  fitToPage: boolean;
  fitWidth: number;
  fitHeight: number;
  /** Inches. */
  margins: { left: number; right: number; top: number; bottom: number; header: number; footer: number };
  gridLines: boolean;
  headings: boolean;
  centerHorizontally: boolean;
  centerVertically: boolean;
  /** Excel's codes (&L &C &R sections, &P, &N, &A, &F, &D, &T...). */
  header: string;
  footer: string;
  firstPageNumber: number | null;
  overThenDown: boolean;
  /** Manual breaks: the rows and columns that start a page. */
  rowBreaks: number[];
  colBreaks: number[];
}

export const DEFAULT_PAGE_SETUP: PageSetup = {
  orientation: 'portrait',
  paperSize: 1,
  scale: 100,
  fitToPage: false,
  fitWidth: 1,
  fitHeight: 1,
  margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
  gridLines: false,
  headings: false,
  centerHorizontally: false,
  centerVertically: false,
  header: '',
  footer: '',
  firstPageNumber: null,
  overThenDown: false,
  rowBreaks: [],
  colBreaks: [],
};

const on = (v: string | undefined) => v === '1' || v === 'true';
const child = (root: XmlElement, name: string) => [...elements(root)].find((c) => c.name === name);

/** The sheet's page setup from its XML (Excel's defaults where it says nothing). */
export function readPageSetup(root: XmlElement): PageSetup {
  const s: PageSetup = { ...DEFAULT_PAGE_SETUP, margins: { ...DEFAULT_PAGE_SETUP.margins } };
  const fit = child(child(root, 'sheetPr') ?? el('x'), 'pageSetUpPr');
  s.fitToPage = on(fit?.attrs.fitToPage);
  const setup = child(root, 'pageSetup')?.attrs ?? {};
  s.orientation = setup.orientation === 'landscape' ? 'landscape' : 'portrait';
  s.paperSize = +(setup.paperSize ?? 1) || 1;
  s.scale = Math.min(400, Math.max(10, +(setup.scale ?? 100) || 100));
  s.fitWidth = setup.fitToWidth === undefined ? 1 : +setup.fitToWidth;
  s.fitHeight = setup.fitToHeight === undefined ? 1 : +setup.fitToHeight;
  s.overThenDown = setup.pageOrder === 'overThenDown';
  s.firstPageNumber = on(setup.useFirstPageNumber) && setup.firstPageNumber !== undefined ? +setup.firstPageNumber : null;
  const m = child(root, 'pageMargins')?.attrs;
  if (m) for (const k of ['left', 'right', 'top', 'bottom', 'header', 'footer'] as const) if (m[k] !== undefined && Number.isFinite(+m[k])) s.margins[k] = +m[k];
  const p = child(root, 'printOptions')?.attrs ?? {};
  s.gridLines = on(p.gridLines);
  s.headings = on(p.headings);
  s.centerHorizontally = on(p.horizontalCentered);
  s.centerVertically = on(p.verticalCentered);
  const hf = child(root, 'headerFooter');
  const text = (name: string) => {
    const e = hf && child(hf, name);
    return e ? e.children.filter((c): c is string => typeof c === 'string').join('') : '';
  };
  s.header = text('oddHeader');
  s.footer = text('oddFooter');
  const breaks = (name: string) => [...elements(child(root, name) ?? el('x'))].filter((b) => b.name === 'brk' && b.attrs.id !== undefined && on(b.attrs.man ?? '1')).map((b) => +b.attrs.id!);
  s.rowBreaks = breaks('rowBreaks');
  s.colBreaks = breaks('colBreaks');
  return s;
}

/** Writes the page setup into the sheet's XML: each element's other attributes kept, Excel's defaults left out. */
export function writePageSetup(root: XmlElement, s: PageSetup, set: (name: string, element: XmlElement | null) => void): void {
  const get = (name: string) => child(root, name);
  // fitToPage lives in sheetPr, which comes first: it is changed in place (or made).
  let pr = get('sheetPr');
  if (s.fitToPage || pr) {
    pr ??= el('sheetPr', {});
    let fit = child(pr, 'pageSetUpPr');
    if (s.fitToPage) {
      if (!fit) pr.children.push((fit = el('pageSetUpPr', {})));
      fit.attrs.fitToPage = '1';
    } else if (fit) delete fit.attrs.fitToPage;
    set('sheetPr', pr);
  }
  const options = get('printOptions') ?? el('printOptions', {});
  const flag = (e: XmlElement, name: string, value: boolean) => (value ? (e.attrs[name] = '1') : delete e.attrs[name]);
  flag(options, 'gridLines', s.gridLines);
  flag(options, 'headings', s.headings);
  flag(options, 'horizontalCentered', s.centerHorizontally);
  flag(options, 'verticalCentered', s.centerVertically);
  set('printOptions', Object.keys(options.attrs).length ? options : null);
  const m = s.margins;
  set('pageMargins', el('pageMargins', { left: m.left, right: m.right, top: m.top, bottom: m.bottom, header: m.header, footer: m.footer }));
  const setup = get('pageSetup') ?? el('pageSetup', {});
  const attr = (name: string, value: string | number | null) => (value === null ? delete setup.attrs[name] : (setup.attrs[name] = String(value)));
  attr('paperSize', s.paperSize === 1 ? null : s.paperSize);
  attr('scale', s.scale === 100 ? null : s.scale);
  attr('fitToWidth', s.fitWidth === 1 ? null : s.fitWidth);
  attr('fitToHeight', s.fitHeight === 1 ? null : s.fitHeight);
  attr('orientation', s.orientation);
  attr('pageOrder', s.overThenDown ? 'overThenDown' : null);
  attr('firstPageNumber', s.firstPageNumber);
  attr('useFirstPageNumber', s.firstPageNumber === null ? null : 1);
  set('pageSetup', setup);
  const hf = get('headerFooter') ?? el('headerFooter', {});
  hf.children = hf.children.filter((c) => typeof c === 'string' || (c.name !== 'oddHeader' && c.name !== 'oddFooter'));
  if (s.header) hf.children.unshift(el('oddHeader', {}, [s.header]));
  if (s.footer) hf.children.splice(s.header ? 1 : 0, 0, el('oddFooter', {}, [s.footer]));
  set('headerFooter', hf.children.length ? hf : null);
  const breaks = (name: string, list: number[], max: number) =>
    set(name, list.length ? el(name, { count: list.length, manualBreakCount: list.length }, [...list].sort((a, b) => a - b).map((id) => el('brk', { id, max, man: 1 }))) : null);
  breaks('rowBreaks', s.rowBreaks, 16383);
  breaks('colBreaks', s.colBreaks, 1048575);
}

// --- Print area and titles ---------------------------------------------------------------------------------------------

/** The sheet's print area (the first of its ranges) and title rows and columns, from its `_xlnm.` names. */
export function printNames(names: DefinedName[], sheet: number): { area: CellRange | null; titleRows: [number, number] | null; titleCols: [number, number] | null } {
  const own = (name: string) => names.find((n) => n.sheet === sheet && n.name.toLowerCase() === name.toLowerCase())?.formula;
  const strip = (part: string) => part.trim().replace(/^(?:'(?:[^']|'')+'|[^!]+)!/, '').replace(/\$/g, '');
  const areaText = own('_xlnm.Print_Area');
  const area = areaText ? parseRange(strip(areaText.split(',')[0])) : null;
  let titleRows: [number, number] | null = null;
  let titleCols: [number, number] | null = null;
  for (const part of (own('_xlnm.Print_Titles') ?? '').split(',')) {
    const t = strip(part);
    const rows = /^(\d+):(\d+)$/.exec(t);
    const cols = /^([A-Za-z]+):([A-Za-z]+)$/.exec(t);
    if (rows) titleRows = [+rows[1] - 1, +rows[2] - 1];
    else if (cols) {
      const r = parseRange(`${cols[1]}1:${cols[2]}1`);
      if (r) titleCols = [r.c0, r.c1];
    }
  }
  return { area, titleRows, titleCols };
}

/** The names with the sheet's print area and titles set (or taken away). */
export function setPrintNames(names: DefinedName[], sheet: number, quoted: string, area: CellRange | null, titleRows: [number, number] | null, titleCols: [number, number] | null): DefinedName[] {
  const lower = new Set(['_xlnm.print_area', '_xlnm.print_titles']);
  const kept = names.filter((n) => !(n.sheet === sheet && lower.has(n.name.toLowerCase())));
  const abs = (r: CellRange) => rangeName(r).replace(/([A-Z]+)(\d+)/g, '$$$1$$$2');
  const col = (c: number) => rangeName({ r0: 0, c0: c, r1: 0, c1: c }).replace(/\d+/g, '');
  if (area) kept.push({ name: '_xlnm.Print_Area', formula: `${quoted}!${abs(area)}`, sheet });
  const titles = [
    ...(titleCols ? [`${quoted}!$${col(titleCols[0])}:$${col(titleCols[1])}`] : []),
    ...(titleRows ? [`${quoted}!$${titleRows[0] + 1}:$${titleRows[1] + 1}`] : []),
  ];
  if (titles.length) kept.push({ name: '_xlnm.Print_Titles', formula: titles.join(','), sheet });
  return kept;
}

// --- Pages -------------------------------------------------------------------------------------------------------------

export interface PrintPage {
  /** The rows and columns of the sheet on it (titles not counted). */
  rows: [number, number];
  cols: [number, number];
}

export interface PrintLayout {
  /** The paper (points), and where the cells start on it. */
  width: number;
  height: number;
  /** The scale the cells print at. */
  scale: number;
  pages: PrintPage[];
  titleRows: [number, number] | null;
  titleCols: [number, number] | null;
  setup: PageSetup;
}

/** The cells in use: the last row and column with a value (or a fill or border: a formatted empty cell prints too). */
function usedRange(sheet: Worksheet): CellRange | null {
  const grid = sheet.grid;
  let r1 = -1;
  let c1 = -1;
  let r0 = Infinity;
  let c0 = Infinity;
  for (let c = 0; c < grid.cols; c++) {
    grid.columns[c]?.forEach(0, grid.rows, (row, kind) => {
      if (kind === Kind.Empty) return;
      r0 = Math.min(r0, row);
      c0 = Math.min(c0, c);
      r1 = Math.max(r1, row);
      c1 = Math.max(c1, c);
    });
  }
  // Charts print too: the cells they reach count as in use.
  for (const chart of sheet.charts) {
    const { from, to, size } = chart.anchor;
    const end = to ?? {
      col: sheet.colSizes.indexAt(sheet.colSizes.position(from.col) + from.dx + (size?.width ?? 360)),
      row: sheet.rowSizes.indexAt(sheet.rowSizes.position(from.row) + from.dy + (size?.height ?? 216)),
      dx: 1,
      dy: 1,
    };
    r1 = Math.max(r1, end.dy > 0 ? end.row : end.row - 1);
    c1 = Math.max(c1, end.dx > 0 ? end.col : end.col - 1);
  }
  if (r1 < 0) return null;
  // Excel prints from A1 when the cells in use start near it, as most sheets do.
  return { r0: 0, c0: 0, r1, c1 };
}

/** Cuts a run of sizes (points, at scale) into pages of `room`, starting a page at each manual break. */
function cut(from: number, to: number, size: (i: number) => number, room: number, breaks: Set<number>): [number, number][] {
  const out: [number, number][] = [];
  let start = from;
  let used = 0;
  for (let i = from; i <= to; i++) {
    const s = size(i);
    if (i > start && (breaks.has(i) || used + s > room + 1e-6)) {
      out.push([start, i - 1]);
      start = i;
      used = 0;
    }
    used += s;
  }
  out.push([start, to]);
  return out;
}

/** The sheet's pages, as Excel cuts them. */
export function printLayout(book: Workbook, sheet: Worksheet, index: number, setup: PageSetup, sizes?: { col(c: number): number; row(r: number): number }): PrintLayout {
  const [pw, ph] = PAPER[setup.paperSize] ?? PAPER[1];
  const [width, height] = setup.orientation === 'landscape' ? [ph, pw] : [pw, ph];
  const names = printNames(book.names, index);
  const area = names.area ?? usedRange(sheet);
  const empty: PrintLayout = { width, height, scale: 1, pages: [], titleRows: names.titleRows, titleCols: names.titleCols, setup };
  if (!area) return empty;
  const m = setup.margins;
  const roomW = width - (m.left + m.right) * 72;
  const roomH = height - (m.top + m.bottom) * 72;
  const colW = sizes?.col ?? ((c: number) => sheet.colSizes.size(c));
  const rowH = sizes?.row ?? ((r: number) => sheet.rowSizes.size(r));
  const sum = (a: number, b: number, size: (i: number) => number) => {
    let s = 0;
    for (let i = a; i <= b; i++) s += size(i);
    return s;
  };
  // Headings take a column of row numbers and a row of letters.
  const headW = setup.headings ? 30 : 0;
  const headH = setup.headings ? sheet.rowSizes.default : 0;
  const titleW = names.titleCols ? sum(names.titleCols[0], names.titleCols[1], colW) : 0;
  const titleH = names.titleRows ? sum(names.titleRows[0], names.titleRows[1], rowH) : 0;
  let scale = setup.scale / 100;
  if (setup.fitToPage) {
    // The largest scale (at most 100%) at which the area fits in so many pages across and down.
    const w = sum(area.c0, area.c1, colW);
    const h = sum(area.r0, area.r1, rowH);
    const fits = (s: number) => {
      const across = cut(area.c0, area.c1, (c) => colW(c) * s, roomW - (headW + titleW) * s, new Set(setup.colBreaks)).length;
      const down = cut(area.r0, area.r1, (r) => rowH(r) * s, roomH - (headH + titleH) * s, new Set(setup.rowBreaks)).length;
      return (!setup.fitWidth || across <= setup.fitWidth) && (!setup.fitHeight || down <= setup.fitHeight);
    };
    scale = 1;
    if (!fits(1)) {
      // A first guess from the sizes, then down in steps until it fits (Excel works in whole percents).
      const guess = Math.min(setup.fitWidth ? (setup.fitWidth * roomW) / (w + headW + titleW) : 1, setup.fitHeight ? (setup.fitHeight * roomH) / (h + headH + titleH) : 1, 1);
      let percent = Math.max(10, Math.floor(guess * 100));
      while (percent > 10 && !fits(percent / 100)) percent--;
      scale = percent / 100;
    }
  }
  const across = cut(area.c0, area.c1, (c) => colW(c) * scale, roomW - (headW + titleW) * scale, new Set(setup.colBreaks));
  const down = cut(area.r0, area.r1, (r) => rowH(r) * scale, roomH - (headH + titleH) * scale, new Set(setup.rowBreaks));
  const pages: PrintPage[] = [];
  if (setup.overThenDown) for (const rows of down) for (const cols of across) pages.push({ rows, cols });
  else for (const cols of across) for (const rows of down) pages.push({ rows, cols });
  return { ...empty, scale, pages };
}

// --- Headers and footers -----------------------------------------------------------------------------------------------

export interface HeaderFooterText {
  left: string;
  center: string;
  right: string;
}

/** A header or footer's three parts with its fields filled in (&P page, &N pages, &A sheet, &F file, &D date, &T time,
 * && an ampersand); font codes (&"Arial,Bold", &12, &B...) are left out. */
export function headerFooterText(code: string, fields: { page: number; pages: number; sheet: string; file: string; date: Date }): HeaderFooterText {
  const out: HeaderFooterText = { left: '', center: '', right: '' };
  let part: keyof HeaderFooterText = 'center';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch !== '&') {
      out[part] += ch;
      continue;
    }
    const next = code[++i] ?? '';
    switch (next) {
      case 'L':
        part = 'left';
        break;
      case 'C':
        part = 'center';
        break;
      case 'R':
        part = 'right';
        break;
      case 'P':
        out[part] += String(fields.page);
        break;
      case 'N':
        out[part] += String(fields.pages);
        break;
      case 'A':
        out[part] += fields.sheet;
        break;
      case 'F':
        out[part] += fields.file;
        break;
      case 'D':
        out[part] += fields.date.toLocaleDateString();
        break;
      case 'T':
        out[part] += fields.date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        break;
      case '&':
        out[part] += '&';
        break;
      case '"': {
        const close = code.indexOf('"', i + 1);
        i = close < 0 ? code.length : close;
        break;
      }
      default:
        // A font size (&12) is digits; other codes (&B, &I, &U, &S, &X, &Y, &K...) are one letter (&K takes a colour).
        if (/\d/.test(next)) while (/\d/.test(code[i + 1] ?? '')) i++;
        else if (next === 'K') i += 6;
    }
  }
  return out;
}
