// Editing a block of text as text: the block becomes a list of cells (one per glyph, still holding
// the bytes and style it was shown with), the new text is matched against them so unchanged
// characters keep their own glyphs and styles, characters typed take the style of their
// neighbours, and the result is wrapped into lines and shown again as content operators. Glyphs
// that were already there are shown from their original bytes in their original font, so nothing
// has to be re-encoded for them; only characters that are new need a font that has them.

import { N, PdfString } from '../core/objects.ts';
import type { Operation } from '../content/content.ts';
import type { TextBlock } from './blocks.ts';
import type { FontUse, Glyph, Rgb, TextRun } from './scan.ts';

/** What a character is shown with. A scanned run is one; so is a new text box's. */
export type Style = Pick<TextRun, 'font' | 'size' | 'color' | 'scale' | 'rise' | 'charSpace' | 'wordSpace' | 'k'>;

export interface Cell {
  /** The character it stands for (a ligature glyph stands for its letters; '\n' is a line break). */
  ch: string;
  /** Present for a glyph that was in the file. */
  glyph?: Glyph;
  style: Style;
  /** The line it was on, for a glyph (or gap) that was in the file. */
  line?: number;
}

/**
 * How to show a character the style's own font can't. Null: nothing can. `size` and `scale`
 * multiply the style's size and horizontal scaling (a stand-in font brought to the size and
 * width of the one it stands in for).
 */
export type Fallback = (style: Style, ch: string) => { font: FontUse; bytes: Uint8Array; width: number; size?: number; scale?: number } | null;

/** A cell with what it takes to show it. */
export interface Placed {
  cell: Cell;
  font: FontUse;
  bytes: Uint8Array;
  /** Font size and horizontal scaling it is shown at: the style's, unless a stand-in font needs its own. */
  size: number;
  scale: number;
  /** Advance in user space. */
  advance: number;
  /** What the font's own width makes it, so the difference can be written as kerning. */
  natural: number;
}

export const UNKNOWN = '�';

const isSpace = (ch: string) => ch === ' ';

const runWidth = (run: TextRun): number => run.glyphs.reduce((n, g) => n + g.advance, 0);

/** The cells of a block: its glyphs in order, with a space cell where a gap or a line break stood for one. */
export function cellsOf(block: TextBlock): Cell[] {
  const cells: Cell[] = [];
  block.lines.forEach((line, li) => {
    let end = NaN;
    for (const run of line.runs) {
      const last = cells[cells.length - 1];
      if (last && last.line === li && !isSpace(last.ch) && run.x - end > run.size * 0.15) cells.push({ ch: ' ', style: last.style, line: li });
      for (const glyph of run.glyphs) cells.push({ ch: glyph.text || UNKNOWN, glyph, style: run, line: li });
      end = run.x + runWidth(run);
    }
    if (li < block.lines.length - 1) {
      const last = cells[cells.length - 1];
      const next = block.lines[li + 1].runs[0]?.glyphs[0]?.text ?? '';
      const hyphenated = last?.ch === '-' && /^\p{L}/u.test(next);
      if (last && !isSpace(last.ch) && !hyphenated) cells.push({ ch: ' ', style: last.style, line: li });
    }
  });
  return cells;
}

export const textOf = (cells: readonly Cell[]): string => cells.map((c) => c.ch).join('');

/** Splits text into the pieces cells stand for: a code point each, or a longer piece where a cell has one (a ligature). */
function tokens(text: string, cells: readonly Cell[]): string[] {
  const multi = [...new Set(cells.map((c) => c.ch).filter((c) => [...c].length > 1))].sort((a, b) => b.length - a.length);
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    const long = multi.find((m) => text.startsWith(m, i));
    if (long) {
      out.push(long);
      i += long.length;
      continue;
    }
    const cp = String.fromCodePoint(text.codePointAt(i)!);
    out.push(cp);
    i += cp.length;
  }
  return out;
}

const LCS_LIMIT = 4_000_000;

/**
 * The cells after the text is changed to `text`: characters that stay keep their cell; new ones
 * are given the style of the character they replace, else the one before, else the one after.
 * `base` styles text when there were no cells at all.
 */
export function editCells(old: readonly Cell[], text: string, base?: Style): Cell[] {
  const b = tokens(text, old);
  const a = old.map((c) => c.ch);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  // The middle, matched by longest common subsequence where that is affordable.
  const n = endA - start;
  const m = endB - start;
  const keep = new Map<number, number>(); // old index -> new index
  for (let i = 0; i < start; i++) keep.set(i, i);
  if (n && m && n * m <= LCS_LIMIT) {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        keep.set(start + i, start + j);
        i++;
        j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
      else j++;
    }
  }
  for (let k = 0; k < a.length - endA; k++) keep.set(endA + k, endB + k);

  const newToOld: number[] = new Array(b.length).fill(-1);
  for (const [i, j] of keep) newToOld[j] = i;
  const kept = new Set(keep.keys());
  const out: Cell[] = [];
  let prevOld = -1;
  for (let j = 0; j < b.length; j++) {
    const i = newToOld[j];
    if (i >= 0) {
      out.push(old[i]);
      prevOld = i;
      continue;
    }
    // A replacement takes the style of the first character it replaces; an insertion, of the one before it, else the one after.
    const replaced = prevOld + 1 < old.length && !kept.has(prevOld + 1) ? old[prevOld + 1] : undefined;
    const after = newToOld.slice(j).find((x) => x >= 0);
    const style = replaced?.style ?? out[out.length - 1]?.style ?? (after !== undefined ? old[after].style : undefined) ?? old[0]?.style ?? base;
    if (!style) throw new Error('nothing to take the style of new text from');
    out.push({ ch: b[j], style });
  }
  return out;
}

/** Cells for text shown all in one style (a new text box). */
export function styledCells(text: string, style: Style): Cell[] {
  return [...text].map((ch) => ({ ch, style }));
}

/** Works out what shows each cell and how far it advances. */
export function place(cells: readonly Cell[], fallback?: Fallback): Placed[] {
  return cells
    .filter((c) => c.ch !== '\n')
    .map((cell) => {
      const { style, glyph } = cell;
      if (glyph) {
        return { cell, font: style.font, bytes: glyph.bytes, size: style.size, scale: style.scale, advance: glyph.advance, natural: glyph.width * style.size * style.scale };
      }
      const spacing = (style.charSpace + (isSpace(cell.ch) ? style.wordSpace : 0)) * style.scale * style.k;
      const embedded = style.font.embedded;
      if (embedded && [...cell.ch].length === 1 && embedded.hasChar(cell.ch.codePointAt(0)!)) {
        const natural = embedded.widthOf(cell.ch, 1) * style.size * style.scale;
        return { cell, font: style.font, bytes: embedded.encode(cell.ch), size: style.size, scale: style.scale, advance: natural + spacing, natural };
      }
      const own = embedded ? undefined : style.font.textFont.characters.get(cell.ch);
      if (own) {
        const natural = own.width * style.size * style.scale;
        return { cell, font: style.font, bytes: own.bytes, size: style.size, scale: style.scale, advance: natural + spacing, natural };
      }
      const other = fallback?.(style, cell.ch);
      if (other) {
        const size = style.size * (other.size ?? 1);
        const scale = style.scale * (other.scale ?? 1);
        const natural = other.width * size * scale;
        return { cell, font: other.font, bytes: other.bytes, size, scale, advance: natural, natural };
      }
      // Nothing can show it: leave a gap the size of a space.
      const gap = (style.font.textFont.characters.get(' ')?.width ?? 0.25) * style.size * style.scale;
      return { cell, font: style.font, bytes: new Uint8Array(0), size: style.size, scale: style.scale, advance: gap, natural: 0 };
    });
}

/** Cells to lines: broken at spaces where a line would pass `width` (Infinity: only at '\n'). */
export function wrap(cells: readonly Cell[], placed: readonly Placed[], firstWidth: number, width: number): Cell[][] {
  const advance = new Map<Cell, number>();
  for (const p of placed) advance.set(p.cell, p.advance);
  const lines: Cell[][] = [];
  let line: Cell[] = [];
  let lineWidth = 0;
  let word: Cell[] = [];
  let wordWidth = 0;
  // A little slack, so text that fitted before (its lines were set by another program) still fits.
  const limit = () => (lines.length === 0 ? firstWidth : width) + 0.5;
  const trim = (l: Cell[]) => {
    let end = l.length;
    while (end > 0 && isSpace(l[end - 1].ch)) end--;
    return l.slice(0, end);
  };
  const widthOf = (l: readonly Cell[]) => l.reduce((n, c) => n + (advance.get(c) ?? 0), 0);
  const commit = () => {
    if (!word.length) return;
    const bare = widthOf(trim(word));
    if (line.length && lineWidth + bare > limit()) {
      lines.push(trim(line));
      line = [];
      lineWidth = 0;
    }
    line.push(...word);
    lineWidth += wordWidth;
    word = [];
    wordWidth = 0;
  };
  for (const cell of cells) {
    if (cell.ch === '\n') {
      commit();
      lines.push(trim(line));
      line = [];
      lineWidth = 0;
      continue;
    }
    word.push(cell);
    wordWidth += advance.get(cell) ?? 0;
    if (isSpace(cell.ch)) commit();
  }
  commit();
  lines.push(trim(line));
  return lines;
}

const round = (n: number, digits = 4): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

const colorOps = (c: Rgb): Operation => ({ op: 'rg', operands: c.map((x) => round(x)) });

/** Operators that show one line of placed cells, starting at (x, y) in user space, as separate runs where the style changes. */
export function emitLine(line: readonly Placed[], x: number, y: number): Operation[] {
  const ops: Operation[] = [];
  let at = x;
  for (let i = 0; i < line.length; ) {
    const first = line[i];
    const key = styleKey(first);
    let j = i;
    let width = 0;
    while (j < line.length && styleKey(line[j]) === key) width += line[j++].advance;
    const { style, font } = { style: first.cell.style, font: first.font };
    const parts: (PdfString | number)[] = [];
    let bytes: number[] = [];
    const flush = () => {
      if (bytes.length) parts.push(new PdfString(Uint8Array.from(bytes), font.textFont.composite));
      bytes = [];
    };
    const per = first.size * first.scale;
    for (let k = i; k < j; k++) {
      const p = line[k];
      if (!p.bytes.length && !p.advance) continue;
      bytes.push(...p.bytes);
      const adjust = per ? ((p.natural - p.advance) * 1000) / per : 0;
      if (Math.abs(adjust) > 0.01) {
        flush();
        parts.push(round(adjust, 3));
      }
    }
    flush();
    if (parts.some((p) => p instanceof PdfString)) {
      ops.push({ op: 'q', operands: [] }, colorOps(style.color), { op: 'BT', operands: [] });
      // The text state is whatever the surrounding content left: say every part of it.
      ops.push({ op: 'Tf', operands: [N(font.resource), round(first.size, 3)] });
      ops.push({ op: 'Tc', operands: [0] }, { op: 'Tw', operands: [0] }, { op: 'Tr', operands: [0] });
      ops.push({ op: 'Tz', operands: [round(first.scale * 100, 3)] }, { op: 'Ts', operands: [round(style.rise * style.k, 3)] });
      ops.push({ op: 'Tm', operands: [1, 0, 0, 1, round(at, 3), round(y, 3)] });
      ops.push(parts.length === 1 ? { op: 'Tj', operands: [parts[0]] } : { op: 'TJ', operands: [parts] });
      ops.push({ op: 'ET', operands: [] }, { op: 'Q', operands: [] });
    }
    at += width;
    i = j;
  }
  return ops;
}

const styleKey = (p: Placed): string => {
  const s = p.cell.style;
  return `${p.font.resource}|${p.size}|${s.color.join(',')}|${p.scale}|${s.rise}`;
};

/** Total advance of a line. */
export const lineAdvance = (line: readonly Placed[]): number => line.reduce((n, p) => n + p.advance, 0);
