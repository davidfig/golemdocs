// Where a cell's text goes (docs/spreadsheets.md, "Drawing"): aligned in its box as Excel aligns it, spilling into empty
// neighbours, wrapped, or replaced by #### when a number does not fit, and cut at the edges it may not cross (whole
// characters are left out, decision 5). Pure: the page gives each character's advance; this places them.

import type { DrawStyle } from './protocol.ts';

/** Space between a cell's edge and its text, in points (Excel's 3 pixels at 100%). */
export const PAD = 2.25;

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PlacedLine {
  /** Characters and where each starts, in points. */
  chars: { cp: number; x: number }[];
  baseline: number;
  /** Where the line starts and ends, for underlines. */
  left: number;
  right: number;
}

export interface Measure {
  /** A character's advance, in ems. */
  advance(cp: number): number;
  ascent: number;
  descent: number;
  /** Line height in ems (for wrapped text). */
  lineHeight: number;
}

/**
 * The lines of a cell's text. `left` and `right` are how far it may reach (its own box, or further over the empty cells
 * it spills into). `fill` is a format's `*x`: that character repeats where it is to fill the width.
 */
export function placeText(text: string, style: DrawStyle, type: 'number' | 'text' | 'logical', box: Box, left: number, right: number, m: Measure, fill?: { char: string; at: number }): PlacedLine[] {
  const size = style.size;
  const width = (s: string) => {
    let w = 0;
    for (const ch of s) w += m.advance(ch.codePointAt(0)!) * size;
    return w;
  };
  const indent = style.indent * 3 * m.advance(0x30) * size;
  const inner = box.x1 - box.x0 - 2 * PAD;
  let shown = text;
  if (fill && !style.wrap) {
    // The repeat fills what is left of the cell: accounting formats put the currency sign at the left this way.
    const one = width(fill.char);
    const room = inner - width(text);
    const count = one > 0 ? Math.max(0, Math.floor(room / one)) : 0;
    shown = text.slice(0, fill.at) + fill.char.repeat(count) + text.slice(fill.at);
  }
  // A number that does not fit shows as #### (dates and times too).
  if (type === 'number' && !style.wrap && !style.shrink && width(shown) > inner + 0.01) {
    const hash = width('#');
    shown = hash > 0 ? '#'.repeat(Math.max(1, Math.floor(inner / hash))) : '#';
  }
  const lines = style.wrap ? wrap(shown, inner - indent, width) : [shown];
  const lineHeight = m.lineHeight * size;
  const blockHeight = lineHeight * (lines.length - 1) + (m.ascent + m.descent) * size;
  const h = style.horizontal === 'general' ? (type === 'number' ? 'right' : type === 'logical' ? 'center' : 'left') : style.horizontal;
  let top: number;
  if (style.vertical === 'top') top = box.y0 + 1;
  else if (style.vertical === 'center' || style.vertical === 'justify' || style.vertical === 'distributed') top = (box.y0 + box.y1 - blockHeight) / 2;
  else top = box.y1 - blockHeight - 1;
  const out: PlacedLine[] = [];
  lines.forEach((line, i) => {
    const baseline = top + m.ascent * size + i * lineHeight;
    // Lines outside the cell's height are not shown (a wrapped cell taller than its row).
    if (style.wrap && (baseline - m.ascent * size < box.y0 - 0.5 || baseline + m.descent * size > box.y1 + 0.5) && i > 0) return;
    const w = width(line);
    let x: number;
    if (h === 'right') x = box.x1 - PAD - indent - w;
    else if (h === 'center' || h === 'centerContinuous' || h === 'distributed') x = (box.x0 + box.x1 - w) / 2;
    else x = box.x0 + PAD + indent;
    const chars: { cp: number; x: number }[] = [];
    let at = x;
    for (const ch of line) {
      const cp = ch.codePointAt(0)!;
      const advance = m.advance(cp) * size;
      // Whole characters only, inside what the cell may reach.
      if (at >= left - 0.01 && at + advance <= right + 0.01) chars.push({ cp, x: at });
      at += advance;
    }
    out.push({ chars, baseline, left: Math.max(x, left), right: Math.min(at, right) });
  });
  return out;
}

/** Breaks text into lines no wider than `width`, at spaces (a word longer than the line breaks within itself), and at newlines. */
export function wrap(text: string, width: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    const words = paragraph.split(/(?<= )/);
    let line = '';
    for (const word of words) {
      if (line && measure(line + word.trimEnd()) > width) {
        out.push(line.trimEnd());
        line = '';
      }
      if (!line && measure(word.trimEnd()) > width) {
        // Too long for a line on its own: as many characters as fit, then the rest.
        let piece = '';
        for (const ch of word) {
          if (piece && measure(piece + ch) > width) {
            out.push(piece);
            piece = '';
          }
          piece += ch;
        }
        line = piece;
        continue;
      }
      line += word;
    }
    out.push(line.trimEnd());
  }
  return out;
}
