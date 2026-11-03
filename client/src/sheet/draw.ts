// How a style looks when drawn (docs/spreadsheets.md, "Formatting", "Drawing"): a cell format resolved against the theme
// into colours, a font and borders. Resolved once per style and kept; tables' and conditional formats' layers go on top
// of this in M5.

import type { DrawStyle } from './protocol.ts';
import type { Border, BorderSide, Fill } from './model/styles.ts';
import { resolveColor } from './model/theme.ts';
import type { Workbook } from './model/workbook.ts';

/** Border line widths in points, by Excel's style names. */
const BORDER_WIDTH: Record<string, number> = {
  hair: 0.5,
  thin: 0.75,
  dotted: 0.75,
  dashed: 0.75,
  dashDot: 0.75,
  dashDotDot: 0.75,
  medium: 1.5,
  mediumDashed: 1.5,
  mediumDashDot: 1.5,
  mediumDashDotDot: 1.5,
  slantDashDot: 1.5,
  thick: 2.25,
  double: 2.25,
};

export function drawStyle(book: Workbook, index: number): DrawStyle {
  const { styles, theme } = book;
  const format = styles.format(index) ?? styles.format(0);
  const font = styles.font(format?.font ?? 0);
  const name = font.scheme === 'major' ? theme.majorFont : font.scheme === 'minor' ? theme.minorFont : font.name;
  const fill = fillColor(styles.fills[format?.fill ?? 0], book);
  const border = styles.borders[format?.border ?? 0] ?? {};
  const a = format?.alignment ?? {};
  return {
    font: name,
    size: font.size,
    bold: !!font.bold,
    italic: !!font.italic,
    underline: font.underline === 'double' || font.underline === 'doubleAccounting' ? 2 : font.underline ? 1 : 0,
    strike: !!font.strike,
    color: resolveColor(font.color, theme, 0x000000, styles.indexedColors),
    fill,
    horizontal: a.horizontal ?? 'general',
    vertical: a.vertical ?? 'bottom',
    wrap: !!a.wrapText,
    shrink: !!a.shrinkToFit,
    indent: a.indent ?? 0,
    rotation: a.textRotation ?? 0,
    borders: (['left', 'right', 'top', 'bottom'] as const).map((side) => borderSide(border[side], book)),
  };
}

function borderSide(side: BorderSide | undefined, book: Workbook): [number, number] | null {
  if (!side || side.style === 'none') return null;
  return [BORDER_WIDTH[side.style] ?? 0.75, resolveColor(side.color, book.theme, 0x000000, book.styles.indexedColors)];
}

/** A fill as one colour (a pattern is drawn as its foreground mixed with its background; a gradient as its middle). */
export function fillColor(fill: Fill | undefined, book: Workbook): number | null {
  if (!fill) return null;
  const { theme, styles } = book;
  if ('gradient' in fill) {
    const stops = fill.stops;
    if (!stops.length) return null;
    return mix(resolveColor(stops[0].color, theme, 0xffffff, styles.indexedColors), resolveColor(stops[stops.length - 1].color, theme, 0xffffff, styles.indexedColors), 0.5);
  }
  if (fill.pattern === 'none') return null;
  const fg = resolveColor(fill.fg, theme, 0x000000, styles.indexedColors);
  if (fill.pattern === 'solid') return fg;
  const bg = resolveColor(fill.bg, theme, 0xffffff, styles.indexedColors);
  // Patterns by how much of the cell their foreground covers.
  const share: Record<string, number> = { gray125: 0.125, gray0625: 0.0625, lightGray: 0.25, mediumGray: 0.5, darkGray: 0.75 };
  return mix(bg, fg, share[fill.pattern] ?? 0.5);
}

/** `a` moved towards `b` by `t`. */
export function mix(a: number, b: number, t: number): number {
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

export type { Border };
