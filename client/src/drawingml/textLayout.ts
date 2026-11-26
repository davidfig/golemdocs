// Laying out a shape's text (docs/architecture/drawingml.md): paragraphs broken into lines that fit the text box, with bullets and
// numbers, alignment, line and paragraph spacing, and the box's vertical anchor. Positions are in CSS pixels from the text
// box's top left. Measuring is given (the page measures with the canvas and the app's fonts; tests with a fixed advance), so
// the same code lays out text for drawing, for the editor's caret and for fitting text to its shape.

import { EMU_PER_PX } from './ooxml.ts';
import type { Paragraph, RunStyle, Spacing } from './text.ts';

export const PX_PER_PT = 96 / 72;

export interface FontSpec {
  family: string;
  bold: boolean;
  italic: boolean;
  /** CSS pixels. */
  size: number;
}

export interface TextMeasure {
  /** Width of a string in the font, CSS pixels. */
  width(text: string, font: FontSpec): number;
  /** Ascent and descent of the font, as fractions of its size. */
  metrics(family: string): { ascent: number; descent: number };
}

/** A fixed-advance measure (half the size per character), for tests and for when no canvas is at hand. */
export const ROUGH_MEASURE: TextMeasure = {
  width: (text, font) => text.length * font.size * 0.5,
  metrics: () => ({ ascent: 0.95, descent: 0.27 }),
};

export interface LaidSegment {
  /** From the text box's left. */
  x: number;
  width: number;
  text: string;
  /** The run in the paragraph, -1 for a bullet. */
  run: number;
  /** Character offset in the paragraph where the segment starts. */
  offset: number;
  style: RunStyle;
  font: FontSpec;
}

export interface LaidLine {
  paragraph: number;
  /** Top and baseline from the text box's top, and height. */
  top: number;
  baseline: number;
  height: number;
  /** Where the text of the line starts (after a bullet) and ends. */
  left: number;
  right: number;
  /** Offsets in the paragraph the line covers. */
  start: number;
  end: number;
  segments: LaidSegment[];
}

export interface LaidText {
  lines: LaidLine[];
  /** Height of the whole text. */
  height: number;
  /** The widest line, for text that is not wrapped. */
  width: number;
}

export function fontOf(style: RunStyle, scale = 1): FontSpec {
  const size = style.size * PX_PER_PT * scale * (style.baseline ? 2 / 3 : 1);
  return { family: style.font, bold: style.bold, italic: style.italic, size };
}

/** The paragraph's text, as offsets count it (a line break is one character). */
export function paragraphString(p: Paragraph): string {
  return p.runs.map((r) => r.text).join('');
}

const ROMAN: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

function roman(n: number): string {
  let out = '';
  for (const [v, s] of ROMAN)
    while (n >= v) {
      out += s;
      n -= v;
    }
  return out;
}

function alpha(n: number): string {
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

/** An automatic number as a scheme writes it (`arabicPeriod` 3 → "3."). */
export function autoNumber(scheme: string, n: number): string {
  const m = /^(arabic|alphaLc|alphaUc|romanLc|romanUc|circleNumDb|circleNumWdBlack|circleNumWdWhite)(.*)$/.exec(scheme);
  const kind = m?.[1] ?? 'arabic';
  const tail = m?.[2] ?? 'Period';
  const body = kind === 'alphaLc' ? alpha(n) : kind === 'alphaUc' ? alpha(n).toUpperCase() : kind === 'romanLc' ? roman(n) : kind === 'romanUc' ? roman(n).toUpperCase() : String(n);
  switch (tail) {
    case 'ParenBoth':
      return `(${body})`;
    case 'ParenR':
      return `${body})`;
    case 'Plain':
      return body;
    case 'Minus':
      return `- ${body} -`;
    default:
      return `${body}.`;
  }
}

/** The bullet text of each paragraph (numbers counted along the list), null where there is none. */
export function bulletTexts(paragraphs: readonly Paragraph[]): (string | null)[] {
  const counters: (number | null)[] = [];
  const schemes: string[] = [];
  return paragraphs.map((p) => {
    const b = p.bullet;
    // A shallower paragraph ends the numbering of the deeper levels.
    for (let l = p.level + 1; l < counters.length; l++) counters[l] = null;
    if (!b) {
      counters[p.level] = null;
      return null;
    }
    if (b.kind === 'char') {
      counters[p.level] = null;
      return b.char;
    }
    const prev = counters[p.level];
    const n = prev != null && schemes[p.level] === b.scheme ? prev + 1 : b.startAt;
    counters[p.level] = n;
    schemes[p.level] = b.scheme;
    return autoNumber(b.scheme, n);
  });
}

interface Piece {
  text: string;
  run: number;
  offset: number;
  style: RunStyle;
  font: FontSpec;
  width: number;
  /** Ends in spaces (where a line may break), is a line break, or a tab. */
  space: boolean;
  newline: boolean;
  tab: boolean;
}

/** Splits text where a line may break: after spaces and hyphens, and around each CJK character. */
const BREAKS = /[^\s\-⺀-鿿가-힯豈-﫿　-〿\t]*(?:[\s\-]+|[⺀-鿿가-힯豈-﫿　-〿]|$)|\t/gy;

function shown(text: string, style: RunStyle): string {
  return style.caps === 'all' || style.caps === 'small' ? text.toUpperCase() : text;
}

function measured(measure: TextMeasure, text: string, style: RunStyle, font: FontSpec): number {
  const t = shown(text, style);
  const w = measure.width(t, style.caps === 'small' ? { ...font, size: font.size * 0.8 } : font);
  return w + style.spacing * PX_PER_PT * t.length;
}

function pieces(p: Paragraph, measure: TextMeasure, scale: number): Piece[] {
  const out: Piece[] = [];
  let offset = 0;
  p.runs.forEach((run, index) => {
    const font = fontOf(run.style, scale);
    if (run.kind === 'break') {
      out.push({ text: '', run: index, offset, style: run.style, font, width: 0, space: false, newline: true, tab: false });
      offset += 1;
      return;
    }
    const text = run.text;
    BREAKS.lastIndex = 0;
    let i = 0;
    while (i < text.length) {
      BREAKS.lastIndex = i;
      const m = BREAKS.exec(text);
      let piece = m && m[0].length ? m[0] : text.slice(i, i + 1);
      if (!piece) piece = text.slice(i);
      const tab = piece === '\t';
      out.push({ text: piece, run: index, offset: offset + i, style: run.style, font, width: tab ? 0 : measured(measure, piece, run.style, font), space: /\s$/.test(piece), newline: false, tab });
      i += piece.length;
    }
    offset += text.length;
  });
  return out;
}

function spacingPx(s: Spacing, lineHeight: number): number {
  if (s.pts !== undefined) return s.pts * PX_PER_PT;
  if (s.pct !== undefined) return s.pct * lineHeight;
  return 0;
}

export interface LayoutOptions {
  /** Width of the text box, CSS pixels (Infinity when text is not wrapped). */
  width: number;
  measure: TextMeasure;
  /** Font scale from autofit (the paragraphs' sizes already include the file's own). */
  scale?: number;
  /** Bullet texts, when the paragraphs are only part of a list. */
  bullets?: (string | null)[];
}

/** Lays out paragraphs as lines inside a box of the given width. */
export function layoutText(paragraphs: readonly Paragraph[], options: LayoutOptions): LaidText {
  const { measure } = options;
  const scale = options.scale ?? 1;
  const width = options.width;
  const bullets = options.bullets ?? bulletTexts(paragraphs);
  const lines: LaidLine[] = [];
  let y = 0;
  let widest = 0;
  paragraphs.forEach((p, pi) => {
    const marL = p.marL / EMU_PER_PX;
    const indent = p.indent / EMU_PER_PX;
    const all = pieces(p, measure, scale);
    const endFont = fontOf(p.end, scale);
    const firstFont = all.find((x) => x.text || x.newline)?.font ?? (p.runs[0] ? fontOf(p.runs[0].style, scale) : endFont);
    // Single line height: the font's ascent and descent, as PowerPoint spaces lines (about 1.2 times the size).
    const lineHeightOf = (font: FontSpec): number => {
      const m = measure.metrics(font.family);
      return font.size * (m.ascent + m.descent);
    };
    if (pi > 0) y += spacingPx(p.spaceBefore, lineHeightOf(firstFont));
    // The bullet: at the first line's indent; the text starts at the left margin, or after the bullet if it is wider.
    let bullet: LaidSegment | null = null;
    let firstLeft = marL + indent;
    const bulletText = bullets[pi];
    if (bulletText && p.bullet) {
      const base = all.find((x) => x.text)?.style ?? p.end;
      const size = p.bullet.size.pts !== undefined ? p.bullet.size.pts : base.size * (p.bullet.size.pct ?? 1);
      const style: RunStyle = { ...base, font: p.bullet.font ?? base.font, size, color: p.bullet.color ?? base.color, underline: false, strike: false, link: null, highlight: null, baseline: 0 };
      const font = fontOf(style, scale);
      const w = measure.width(bulletText, font);
      bullet = { x: marL + indent, width: w, text: bulletText, run: -1, offset: 0, style, font };
      const after = marL + indent + w;
      firstLeft = indent < 0 && after <= marL ? marL : after + font.size * 0.3;
    }
    let lineStart = 0;
    let current: Piece[] = [];
    let first = true;
    const left = (): number => (first ? firstLeft : marL);
    const finish = (endOffset: number): void => {
      const lineLeft = left();
      // Trailing spaces hang past the edge, as in PowerPoint.
      let x = lineLeft;
      const segs: LaidSegment[] = [];
      if (first && bullet) segs.push(bullet);
      let maxAscent = 0;
      let maxDescent = 0;
      let maxLine = 0;
      const fonts = current.length ? current.map((c) => c.font) : [endFont];
      for (const f of fonts) {
        const m = measure.metrics(f.family);
        maxAscent = Math.max(maxAscent, f.size * m.ascent);
        maxDescent = Math.max(maxDescent, f.size * m.descent);
        maxLine = Math.max(maxLine, lineHeightOf(f));
      }
      if (first && bullet) {
        const m = measure.metrics(bullet.font.family);
        maxAscent = Math.max(maxAscent, bullet.font.size * m.ascent);
      }
      for (const c of current) {
        if (c.tab) {
          const tabs = p.tabs.map((t) => t / EMU_PER_PX);
          const next = tabs.find((t) => t > x - 0.5) ?? Math.ceil((x + 0.5) / (p.defTab / EMU_PER_PX)) * (p.defTab / EMU_PER_PX);
          segs.push({ x, width: next - x, text: '\t', run: c.run, offset: c.offset, style: c.style, font: c.font });
          x = next;
          continue;
        }
        if (!c.newline) segs.push({ x, width: c.width, text: c.text, run: c.run, offset: c.offset, style: c.style, font: c.font });
        x += c.width;
      }
      const textSegs = segs.filter((s) => s.run >= 0);
      let trailing = 0;
      const last = textSegs[textSegs.length - 1];
      if (last) {
        const trimmed = last.text.replace(/\s+$/, '');
        if (trimmed.length < last.text.length) trailing = last.width - measured(measure, trimmed, last.style, last.font);
      }
      const used = x - lineLeft - trailing;
      const room = (Number.isFinite(width) ? width : used + lineLeft) - lineLeft - used;
      let shift = 0;
      if (p.align === 'ctr') shift = room / 2;
      else if (p.align === 'r') shift = room;
      if (shift) for (const s of segs) if (s.run >= 0) s.x += shift;
      const isLastOfParagraph = endOffset >= paragraphString(p).length;
      if ((p.align === 'just' && !isLastOfParagraph) || p.align === 'dist') {
        const gaps = textSegs.length - 1;
        if (gaps > 0 && room > 0) textSegs.forEach((s, i) => (s.x += (room * i) / gaps));
      }
      const pct = p.lineSpacing.pct ?? 1;
      const height = p.lineSpacing.pts !== undefined ? p.lineSpacing.pts * PX_PER_PT : maxLine * pct;
      const baseline = y + (p.lineSpacing.pts !== undefined ? height - maxDescent : height - maxDescent * pct);
      lines.push({ paragraph: pi, top: y, baseline, height, left: lineLeft + shift, right: lineLeft + shift + used, start: lineStart, end: endOffset, segments: segs });
      widest = Math.max(widest, lineLeft + used);
      y += height;
      first = false;
      current = [];
      lineStart = endOffset;
    };
    let x = firstLeft;
    for (let i = 0; i < all.length; i++) {
      const c = all[i];
      if (c.newline) {
        current.push(c);
        finish(c.offset + 1);
        x = left();
        continue;
      }
      let w = c.width;
      if (c.tab) {
        const tabs = p.tabs.map((t) => t / EMU_PER_PX);
        const next = tabs.find((t) => t > x - 0.5) ?? Math.ceil((x + 0.5) / (p.defTab / EMU_PER_PX)) * (p.defTab / EMU_PER_PX);
        w = next - x;
      }
      const trimmedWidth = c.space ? measured(measure, c.text.replace(/\s+$/, ''), c.style, c.font) : w;
      if (current.length && Number.isFinite(width) && x + trimmedWidth > width + 0.01) {
        finish(c.offset);
        x = left();
      }
      // A piece wider than a whole line is broken between characters.
      if (!current.length && Number.isFinite(width) && !c.tab && trimmedWidth > width - x + 0.01 && c.text.length > 1) {
        let cut = 1;
        while (cut < c.text.length && measured(measure, c.text.slice(0, cut + 1), c.style, c.font) <= width - x) cut++;
        const head: Piece = { ...c, text: c.text.slice(0, cut), width: measured(measure, c.text.slice(0, cut), c.style, c.font) };
        const tail: Piece = { ...c, text: c.text.slice(cut), offset: c.offset + cut, width: measured(measure, c.text.slice(cut), c.style, c.font) };
        current.push(head);
        finish(tail.offset);
        x = left();
        all.splice(i + 1, 0, tail);
        continue;
      }
      current.push(c);
      x += w;
    }
    finish(paragraphString(p).length);
    const lastLine = lines[lines.length - 1];
    y += spacingPx(p.spaceAfter, lastLine ? lastLine.height / Math.max(p.lineSpacing.pct ?? 1, 0.01) : 0);
  });
  // Space after the last paragraph doesn't count towards the text's height.
  const lastP = paragraphs[paragraphs.length - 1];
  const lastLine = lines[lines.length - 1];
  if (lastP && lastLine) y -= spacingPx(lastP.spaceAfter, lastLine.height / Math.max(lastP.lineSpacing.pct ?? 1, 0.01));
  return { lines, height: y, width: widest };
}
