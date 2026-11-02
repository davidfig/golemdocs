// A sheet as a PDF (File › Print, Print Preview; docs/spreadsheets.md, M6): its pages as print.ts cuts them, drawn from
// the same tiles the grid draws (fills, borders, merged cells, text placed by cellText.ts in the same fonts), with the
// title rows and columns on every page, gridlines and headings when the page setup asks, charts and sparklines where
// they are (a chart a break goes through is split, as Excel prints it), and the header and footer.
// Fonts are embedded as the document exporter embeds them (pdfExport.ts). Loaded only when a sheet is printed.

import { PdfDocument } from '@golemdocs/pdf';
import type { EmbeddedFont, PageDrawing, PdfFont } from '@golemdocs/pdf';
import type { FontSet, ResolvedFont } from '@golemdocs/layout';
import { FALLBACK_FAMILY } from '@golemdocs/layout';
import { loadAppFonts } from '../formats/appFonts.ts';
import { embeddable, lineRuns, pdfChar, standardName } from '../formats/pdfExport.ts';
import type { PlacedGlyph } from '../formats/pdfExport.ts';
import { PAD, placeText } from './cellText.ts';
import type { Box, Measure } from './cellText.ts';
import { columnName } from './model/column.ts';
import type { CellRange } from './model/worksheet.ts';
import { headerFooterText } from './print.ts';
import type { CellPaint, DrawStyle, PrintData } from './protocol.ts';

const rgb = (c: number): [number, number, number] => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
const GRID = 0xd0d0d0;
const HEADING_FILL = 0xf2f2f2;
const HEADING_TEXT = 0x404040;
/** The heading column's width, in points (row numbers). */
const HEADING_WIDTH = 30;

export async function sheetToPdf(data: PrintData, set: FontSet, fileName: string, title?: string): Promise<Uint8Array> {
  const { layout, cols, rows } = data;
  const setup = layout.setup;
  const pdf = PdfDocument.create();
  pdf.setMetadata('Title', title ?? data.sheetName);
  pdf.setMetadata('Creator', 'Golem Docs');
  pdf.setMetadata('Producer', 'Golem Docs PDF export');
  // The cells, their styles and merges, from the tiles.
  const styles = new Map<number, DrawStyle>();
  const cells = new Map<string, CellPaint>();
  const merges: CellRange[] = [];
  const seenMerge = new Set<string>();
  for (const tile of data.tiles) {
    for (const [i, s] of tile.styles) styles.set(i, s);
    for (const c of tile.cells) cells.set(`${c.row}:${c.col}`, c);
    for (const m of tile.merges) {
      const key = `${m.r0}:${m.c0}`;
      if (seenMerge.has(key)) continue;
      seenMerge.add(key);
      merges.push(m);
    }
  }
  // Fonts: every face the cells use (and the default, for headings and the header and footer), loaded and embedded.
  const defaultStyle = styles.get(0) ?? { font: FALLBACK_FAMILY, size: 11, bold: false, italic: false };
  const resolved = new Map<string, ResolvedFont>();
  const fontOf = (name: string, bold: boolean, italic: boolean) => {
    const key = `${name}|${bold}|${italic}`;
    let f = resolved.get(key);
    if (!f) resolved.set(key, (f = set.resolve({ font: name, bold, italic })));
    return f;
  };
  fontOf(defaultStyle.font, false, false);
  fontOf(defaultStyle.font, true, false);
  // Charts' text is in Calibri, as the grid draws it.
  if (data.charts?.length) {
    fontOf('Calibri', false, false);
    fontOf('Calibri', true, false);
  }
  for (const s of styles.values()) fontOf(s.font, s.bold, s.italic);
  await set.ensure([...resolved.values()].map((f) => f.face));
  const embedded = new Map<string, EmbeddedFont>();
  for (const f of resolved.values()) {
    if (!embeddable(f) || embedded.has(f.face.font!)) continue;
    const file = await set.fontFile(f.face.font!);
    if (!file) continue;
    try {
      embedded.set(f.face.font!, pdf.embedFont(file));
    } catch {
      // A standard font stands in.
    }
  }
  const standard = new Map<string, PdfFont>();
  const pdfFont = (f: ResolvedFont): PdfFont => {
    const e = embeddable(f) ? embedded.get(f.face.font!) : undefined;
    if (e) return e;
    const name = standardName(f);
    let s = standard.get(name);
    if (!s) standard.set(name, (s = pdf.standardFont(name)));
    return s;
  };
  const measureOf = (f: ResolvedFont): Measure | null => {
    const m = set.metrics(f.face);
    if (!m) return null;
    return { advance: (cp) => m.advance(m.glyph(cp)), ascent: m.ascent, descent: m.descent, lineHeight: m.lineHeight };
  };
  /** Glyphs for placed text: each character's own glyph in an embedded font, else its WinAnsi stand-in. */
  const glyphs = (f: ResolvedFont, size: number, color: number, chars: { cp: number; x: number }[], baseline: number): PlacedGlyph[] => {
    const m = set.metrics(f.face)!;
    const e = embeddable(f) ? embedded.get(f.face.font!) : undefined;
    return chars.map(({ cp, x }) => ({
      x,
      y: baseline,
      size,
      char: e && e.hasChar(cp) ? String.fromCodePoint(cp) : pdfChar(cp).text,
      advance: m.advance(m.glyph(cp)) * size,
      color: 0xff000000 | ((color & 255) << 16) | (color & 0xff00) | ((color >> 16) & 255),
      font: f,
    }));
  };
  const writeText = (d: PageDrawing, list: PlacedGlyph[]) => {
    if (!list.length) return;
    for (const run of lineRuns(list)) d.textRun(run.pieces, run.first.x, run.first.y, { font: pdfFont(run.first.font), size: run.first.size, color: rgb(colorOf(run.first.color)) });
  };
  /** Text in the default font, its left edge at x (center or right: x is its middle or right edge). */
  const label = (d: PageDrawing, text: string, x: number, baseline: number, align: 'left' | 'center' | 'right', color = 0, bold = false, size = defaultStyle.size, family = defaultStyle.font) => {
    if (!text) return;
    const f = fontOf(family, bold, false);
    const m = set.metrics(f.face);
    if (!m) return;
    let width = 0;
    const chars: { cp: number; x: number }[] = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      chars.push({ cp, x: width });
      width += m.advance(m.glyph(cp)) * size;
    }
    const left = align === 'left' ? x : align === 'center' ? x - width / 2 : x - width;
    writeText(d, glyphs(f, size, color, chars.map((c) => ({ ...c, x: c.x + left })), baseline).filter((g) => g.char !== ' '));
  };

  const colX = prefix(cols);
  const rowY = prefix(rows);
  const span = (a: number, b: number, at: number[]) => at[b + 1] - at[a];
  const m = setup.margins;
  const pages = layout.pages;
  const firstNumber = setup.firstPageNumber ?? 1;
  const headW = setup.headings ? HEADING_WIDTH : 0;
  const headH = setup.headings ? (rows[0] ?? 15) : 0;
  const date = new Date();
  for (const [i, p] of pages.entries()) {
    const page = pdf.addPage([layout.width, layout.height]);
    const d = page.draw({ origin: 'top-left' });
    // The header and footer, in the margins.
    const words = (code: string) => headerFooterText(code, { page: firstNumber + i, pages: pages.length, sheet: data.sheetName, file: fileName, date });
    const font = set.metrics(fontOf(defaultStyle.font, false, false).face);
    const ascent = (font?.ascent ?? 0.75) * defaultStyle.size;
    const descent = (font?.descent ?? 0.25) * defaultStyle.size;
    for (const [code, baseline] of [
      [setup.header, m.header * 72 + ascent],
      [setup.footer, layout.height - m.footer * 72 - descent],
    ] as const) {
      if (!code) continue;
      const w = words(code);
      label(d, w.left, m.left * 72, baseline, 'left');
      label(d, w.center, layout.width / 2, baseline, 'center');
      label(d, w.right, layout.width - m.right * 72, baseline, 'right');
    }
    // The blocks of cells on the page: title rows and columns (when the page is past them), then its own.
    const titleRows = layout.titleRows && p.rows[0] > layout.titleRows[1] ? layout.titleRows : null;
    const titleCols = layout.titleCols && p.cols[0] > layout.titleCols[1] ? layout.titleCols : null;
    const rowBands = [...(titleRows ? [titleRows] : []), p.rows];
    const colBands = [...(titleCols ? [titleCols] : []), p.cols];
    const width = headW + colBands.reduce((s, b) => s + span(b[0], b[1], colX), 0);
    const height = headH + rowBands.reduce((s, b) => s + span(b[0], b[1], rowY), 0);
    const s = layout.scale;
    const roomW = layout.width - (m.left + m.right) * 72;
    const roomH = layout.height - (m.top + m.bottom) * 72;
    const x0 = m.left * 72 + (setup.centerHorizontally ? Math.max(0, (roomW - width * s) / 2) : 0);
    const y0 = m.top * 72 + (setup.centerVertically ? Math.max(0, (roomH - height * s) / 2) : 0);
    d.save();
    // Scaled about the page's top left, the cells' top left at (x0, y0): the drawing flips y after this (top-left origin).
    d.transform(s, 0, 0, s, x0, layout.height * (1 - s) - y0);
    let oy = headH;
    for (const rb of rowBands) {
      let ox = headW;
      for (const cb of colBands) {
        drawBlock(d, rb as [number, number], cb as [number, number], ox, oy);
        ox += span(cb[0], cb[1], colX);
      }
      oy += span(rb[0], rb[1], rowY);
    }
    if (setup.headings) {
      // Column letters across the top, row numbers down the left, in light grey boxes.
      const box = (x: number, y: number, w: number, h: number, text: string) => {
        d.rect(x, y, w, h, { fill: rgb(HEADING_FILL), stroke: { color: rgb(GRID), width: 0.5 } });
        label(d, text, x + w / 2, y + h / 2 + ascent / 2 - descent / 4, 'center', HEADING_TEXT);
      };
      box(0, 0, headW, headH, '');
      let x = headW;
      for (const cb of colBands) {
        for (let c = cb[0]; c <= cb[1]; c++) {
          if (!cols[c]) continue;
          box(x, 0, cols[c], headH, columnName(c));
          x += cols[c];
        }
      }
      let y = headH;
      for (const rb of rowBands) {
        for (let r = rb[0]; r <= rb[1]; r++) {
          if (!rows[r]) continue;
          box(0, y, headW, rows[r], String(r + 1));
          y += rows[r];
        }
      }
    }
    d.restore();
    d.finish();
  }
  return pdf.save();

  /** A block of the sheet's cells, its top left at (ox, oy) on the page (before the scale). */
  function drawBlock(d: PageDrawing, [r0, r1]: [number, number], [c0, c1]: [number, number], ox: number, oy: number): void {
    const x = (c: number) => ox + colX[c] - colX[c0];
    const y = (r: number) => oy + rowY[r] - rowY[r0];
    const w = span(c0, c1, colX);
    const h = span(r0, r1, rowY);
    d.save();
    d.rectPath(ox, oy, w, h).clip();
    // Merged cells' boxes; the cells they cover (but the first) draw nothing of their own.
    const mergeAt = new Map<string, Box>();
    const covered = new Set<string>();
    for (const mg of merges) {
      if (mg.r1 < r0 || mg.r0 > r1 || mg.c1 < c0 || mg.c0 > c1) continue;
      mergeAt.set(`${mg.r0}:${mg.c0}`, { x0: x(mg.c0), y0: y(mg.r0), x1: x(mg.c1 + 1), y1: y(mg.r1 + 1) });
      for (let r = mg.r0; r <= mg.r1; r++) for (let c = mg.c0; c <= mg.c1; c++) if (r !== mg.r0 || c !== mg.c0) covered.add(`${r}:${c}`);
    }
    const inBlock: CellPaint[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const cell = cells.get(`${r}:${c}`);
      if (cell && !covered.has(`${r}:${c}`)) inBlock.push(cell);
    }
    // A merge whose first cell is above or left of the block still shows its fill here.
    const boxOf = (cell: CellPaint): Box => mergeAt.get(`${cell.row}:${cell.col}`) ?? { x0: x(cell.col), y0: y(cell.row), x1: x(cell.col + 1), y1: y(cell.row + 1) };
    for (const cell of inBlock) {
      const style = styles.get(cell.style);
      const b = boxOf(cell);
      if (style?.fill !== null && style?.fill !== undefined) d.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, { fill: rgb(style.fill) });
      if (cell.bar) d.rect(b.x0 + (b.x1 - b.x0) * cell.bar.from + 1, b.y0 + 1.5, Math.max(0, (b.x1 - b.x0) * (cell.bar.to - cell.bar.from) - 2), b.y1 - b.y0 - 3, { fill: rgb(cell.bar.color) });
    }
    if (setup.gridLines) {
      d.save().strokeColor(rgb(GRID)).lineWidth(0.5);
      for (let c = c0; c <= c1 + 1; c++) if (c === c1 + 1 || cols[c]) d.moveTo(x(c), oy).lineTo(x(c), oy + h);
      for (let r = r0; r <= r1 + 1; r++) if (r === r1 + 1 || rows[r]) d.moveTo(ox, y(r)).lineTo(ox + w, y(r));
      d.stroke().restore();
    }
    for (const cell of inBlock) {
      const style = styles.get(cell.style);
      if (!style) continue;
      const b = boxOf(cell);
      const [left, right, top, bottom] = style.borders;
      if (left) d.rect(b.x0 - left[0] / 2, b.y0, left[0], b.y1 - b.y0, { fill: rgb(left[1]) });
      if (right) d.rect(b.x1 - right[0] / 2, b.y0, right[0], b.y1 - b.y0, { fill: rgb(right[1]) });
      if (top) d.rect(b.x0, b.y0 - top[0] / 2, b.x1 - b.x0, top[0], { fill: rgb(top[1]) });
      if (bottom) d.rect(b.x0, b.y1 - bottom[0] / 2, b.x1 - b.x0, bottom[0], { fill: rgb(bottom[1]) });
    }
    for (const cell of inBlock) {
      const style = styles.get(cell.style);
      if (!style || !cell.text) continue;
      const f = fontOf(style.font, style.bold, style.italic);
      const measure = measureOf(f);
      if (!measure) continue;
      const b = boxOf(cell);
      const reachLeft = cell.spillLeft ? x(Math.max(c0, cell.col - cell.spillLeft)) + PAD : b.x0;
      const reachRight = cell.spillRight ? x(Math.min(c1 + 1, cell.col + 1 + cell.spillRight)) - PAD : b.x1;
      const color = cell.color ?? style.color;
      const placed = placeText(cell.text, style, cell.type, b, reachLeft, reachRight, measure, cell.fill);
      for (const line of placed) {
        writeText(d, glyphs(f, style.size, color, line.chars.filter((c) => c.cp > 32), line.baseline));
        const metrics = set.metrics(f.face)!;
        if (style.underline && line.chars.length) {
          const thick = Math.max(metrics.underlineThickness * style.size, 0.5);
          const at = line.baseline - metrics.underlinePosition * style.size;
          d.rect(line.left, at, line.right - line.left, thick, { fill: rgb(color) });
          if (style.underline === 2) d.rect(line.left, at + thick * 2, line.right - line.left, thick, { fill: rgb(color) });
        }
        if (style.strike && line.chars.length) d.rect(line.left, line.baseline - metrics.strikeoutPosition * style.size, line.right - line.left, Math.max(metrics.strikeoutThickness * style.size, 0.5), { fill: rgb(color) });
      }
    }
    // Charts and sparklines over the cells: their triangles (one path per colour run), then their text, as the grid draws
    // them (a text's y is its middle).
    for (const scene of data.charts ?? []) {
      const sx = ox + scene.x - colX[c0];
      const sy = oy + scene.y - rowY[r0];
      if (sx > ox + w || sy > oy + h || sx + scene.width < ox || sy + scene.height < oy) continue;
      const p = scene.points;
      let color = -1;
      for (let t = 0; t + 5 < p.length; t += 6) {
        const c = scene.colors[t / 2];
        if (c !== color) {
          if (color >= 0) d.fill();
          d.fillColor(rgb(c));
          color = c;
        }
        d.moveTo(sx + p[t], sy + p[t + 1]).lineTo(sx + p[t + 2], sy + p[t + 3]).lineTo(sx + p[t + 4], sy + p[t + 5]).closePath();
      }
      if (color >= 0) d.fill();
      const calibri = set.metrics(fontOf('Calibri', false, false).face);
      for (const run of scene.texts) {
        const middle = calibri ? ((calibri.ascent - calibri.descent) * run.size) / 2 : run.size / 3;
        label(d, run.text, sx + run.x, sy + run.y + middle, run.align, run.color, run.bold, run.size, 'Calibri');
      }
    }
    d.restore();
  }
}

let appFonts: Promise<FontSet> | null = null;

/** The active sheet's print data as a PDF, in the app's fonts (loaded, with their files, the first time). The page
 * imports this module only when a sheet prints: with the document exporter it builds on, it is no part of the grid. */
export async function printSheet(data: PrintData, fileName: string): Promise<Uint8Array> {
  return sheetToPdf(data, await (appFonts ??= loadAppFonts()), fileName);
}

/** Running sums: where each of `sizes` starts, and one past the last. */
function prefix(sizes: number[]): number[] {
  const out = [0];
  for (const s of sizes) out.push(out[out.length - 1] + s);
  return out;
}

/** A PlacedGlyph's packed colour (layout's little-endian RGBA) back to 0xRRGGBB. */
function colorOf(packed: number): number {
  return ((packed & 255) << 16) | (packed & 0xff00) | ((packed >> 16) & 255);
}
