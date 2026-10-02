// Paragraph layout: turns one paragraph into lines of positioned glyphs for a given width.
// Pure and independent of pagination, so edits can re-lay out just the changed paragraph.

import { CHECKBOX, mergeProperties, type Border, type Drawing, type Paragraph, type ParagraphProperties, type SectionProperties, type TabStop, type XmlElement } from '@golemdocs/docx';
import { parseHexColor } from './display.ts';
import type { FaceMetrics } from './fonts/faceMetrics.ts';
import type { ResolvedFont } from './fonts/fontSet.ts';
import { BLACK, type LayoutContext, type RunStyle } from './context.ts';
import { checkbox, type CheckboxBox } from './checkbox.ts';
import { TAB, TextCollector } from './runs.ts';
import type { SourceSpan } from './offsets.ts';
import { layerKey } from './context.ts';
import { cjkBreakBetween, isCjk } from './fonts/cjk.ts';
import { emitMarks, formattingMarksOn } from './marks.ts';
import type { MathLayout } from './math/layout.ts';
import type { MathEquation } from '@golemdocs/docx';

const SPACE = 0x20;
const twips = (v: number | undefined) => (v ?? 0) / 20;

/** Rect layers: behind text (shading, highlight) or over it (underline, borders). */
export const BEHIND = 0;
export const OVER = 1;

export interface LineLayout {
  /** Top of the line relative to the paragraph's first line top. */
  y: number;
  height: number;
  /** Baseline, from the line's top. */
  baseline: number;
  /** Visible glyphs. x is relative to the column's left edge. */
  glyph: Uint16Array;
  x: Float32Array;
  /** Index into ParagraphLayout.styles (color, baseline shift). */
  style: Uint16Array;
  /** Font size per glyph, points (differs from the style's for small caps, and for the parts of an equation). */
  size: Float32Array;
  /** Vertical offset per glyph from the baseline, points, downward (equation glyphs; 0 for text). */
  dy: Float32Array;
  /** Index into ParagraphLayout.fonts (the face actually used, after fallback). */
  font: Uint8Array;
  /** Rectangles: x, y (from line top), width, height per entry. */
  rects: Float32Array;
  rectColors: Uint32Array;
  rectLayers: Uint8Array;
  images: { part: string; x: number; y: number; width: number; height: number }[];
  /** Range of the paragraph's visible text on this line (list label excluded). */
  start: number;
  end: number;
  /** Left edge and width of the line's content, for hit testing. */
  left: number;
  width: number;
  /** The check box of a task list item, on its first line. */
  box?: CheckboxBox;
  /** The line ends with a page or column break. */
  pageBreak: boolean;
  /** ...and it is a column break (the next column, not the next page, in a section with columns). */
  columnBreak: boolean;
  /**
   * Caret positions: x (relative to the column's left edge) before each visible offset from
   * start to end inclusive, so stops[end - start] is the end of the line.
   */
  stops: Float32Array;
  /** The line ends in a space or break that belongs to it (End puts the caret before it). */
  trailingSpace: boolean;
}

export interface FloatSpec {
  drawing: Drawing;
  behind: boolean;
  h: { relativeFrom: string; offset?: number; align?: string };
  v: { relativeFrom: string; offset?: number; align?: string };
  /** A text box's insets, points. */
  inset: { left: number; top: number; right: number; bottom: number };
}

export interface ParagraphLayout {
  paragraph: Paragraph;
  properties: ParagraphProperties;
  lines: LineLayout[];
  styles: RunStyle[];
  fonts: { font: ResolvedFont; metrics: FaceMetrics }[];
  height: number;
  spaceBefore: number;
  spaceAfter: number;
  keepNext: boolean;
  keepLines: boolean;
  widowControl: boolean;
  pageBreakBefore: boolean;
  contextualSpacing: boolean;
  styleId?: string;
  floats: FloatSpec[];
  /** Section properties if this paragraph ends a section. */
  section?: SectionProperties;
  /** Visible text to model offsets. */
  spans: SourceSpan[];
  /** Visible text length (list label excluded). */
  length: number;
}

/** A paragraph's last layout, reused while nothing it depends on changes. */
export interface CachedParagraph {
  key: string;
  layout: ParagraphLayout;
}

function isBreakAfter(code: number, next: number): boolean {
  if (code === SPACE || code === 0x09 || code === 0x00ad) return true;
  // Hyphens and dashes allow a break after them when followed by more text.
  if ((code === 0x2d || code === 0x2013 || code === 0x2014) && isWordChar(next)) return true;
  return code >= 0x3000 || next >= 0x3000 ? cjkBreakBetween(code, next) : false;
}

/** Letters and digits (a break after a dash needs one to follow, not punctuation). */
function isWordChar(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code >= 0xc0;
}

function isLower(code: number): boolean {
  const ch = String.fromCharCode(code);
  return ch !== ch.toUpperCase();
}

/** Scratch buffers for building lines (reused across paragraphs). */
class LineBuilder {
  glyph: number[] = [];
  x: number[] = [];
  style: number[] = [];
  size: number[] = [];
  dy: number[] = [];
  font: number[] = [];
  rects: number[] = [];
  rectColors: number[] = [];
  rectLayers: number[] = [];
  images: LineLayout['images'] = [];
  box: CheckboxBox | undefined;

  rect(layer: number, x: number, y: number, w: number, h: number, color: number): void {
    if (w <= 0 || h <= 0) return;
    this.rects.push(x, y, w, h);
    this.rectColors.push(color);
    this.rectLayers.push(layer);
  }

  finish(line: Omit<LineLayout, 'glyph' | 'x' | 'style' | 'size' | 'dy' | 'font' | 'rects' | 'rectColors' | 'rectLayers' | 'images' | 'stops'>, stops: Float32Array): LineLayout {
    const out: LineLayout = {
      ...line,
      glyph: Uint16Array.from(this.glyph),
      x: Float32Array.from(this.x),
      style: Uint16Array.from(this.style),
      size: Float32Array.from(this.size),
      dy: Float32Array.from(this.dy),
      font: Uint8Array.from(this.font),
      rects: Float32Array.from(this.rects),
      rectColors: Uint32Array.from(this.rectColors),
      rectLayers: Uint8Array.from(this.rectLayers),
      images: this.images,
      stops,
      ...(this.box && { box: this.box }),
    };
    this.box = undefined;
    this.glyph.length = this.x.length = this.style.length = this.size.length = this.dy.length = this.font.length = 0;
    this.rects.length = this.rectColors.length = this.rectLayers.length = 0;
    this.images = [];
    return out;
  }
}
const builder = new LineBuilder();

function findElement(root: XmlElement, name: string): XmlElement | undefined {
  for (const c of root.children) {
    if (typeof c === 'string') continue;
    if (c.name === name) return c;
    const found = findElement(c, name);
    if (found) return found;
  }
  return undefined;
}

function readFloat(d: Drawing): FloatSpec {
  const anchor = d.xml?.children.find((c) => typeof c !== 'string' && c.name === 'wp:anchor');
  const spec: FloatSpec = { drawing: d, behind: false, h: { relativeFrom: 'column' }, v: { relativeFrom: 'paragraph' }, inset: { left: 7.2, top: 3.6, right: 7.2, bottom: 3.6 } };
  if (!anchor || typeof anchor === 'string') return spec;
  const body = d.textBox && findElement(anchor, 'wps:bodyPr');
  if (body) {
    const points = (name: string, fallback: number) => (body.attrs[name] === undefined ? fallback : Number(body.attrs[name]) / 12700);
    spec.inset = { left: points('lIns', 7.2), top: points('tIns', 3.6), right: points('rIns', 7.2), bottom: points('bIns', 3.6) };
  }
  spec.behind = anchor.attrs.behindDoc === '1' || anchor.attrs.behindDoc === 'true';
  for (const axis of ['H', 'V'] as const) {
    const pos = anchor.children.find((c) => typeof c !== 'string' && c.name === `wp:position${axis}`);
    if (!pos || typeof pos === 'string') continue;
    const target = axis === 'H' ? spec.h : spec.v;
    target.relativeFrom = pos.attrs.relativeFrom ?? target.relativeFrom;
    for (const c of pos.children) {
      if (typeof c === 'string') continue;
      const value = c.children.filter((t) => typeof t === 'string').join('').trim();
      if (c.name === 'wp:posOffset') target.offset = Number(value) / 12700;
      else if (c.name === 'wp:align') target.align = value;
    }
  }
  return spec;
}

/** An equation's layout, once per equation (its object is replaced when it is edited). */
const mathCache = new WeakMap<MathEquation, MathLayout>();
function mathOf(equation: MathEquation, face: FaceMetrics, data: import('./fonts/fontTypes.ts').MathData, engine: typeof import('./math/layout.ts').layoutMath): MathLayout {
  let layout = mathCache.get(equation);
  if (!layout) mathCache.set(equation, (layout = engine(equation.content, face, data, { display: equation.display })));
  return layout;
}

export function layoutParagraph(paragraph: Paragraph, ctx: LayoutContext, width: number): ParagraphLayout {
  const resolver = ctx.resolver;
  const props = resolver.paragraph(paragraph.properties, ctx.layer);
  // The label advances list counters whether or not the layout below is reused.
  const label = props.numbering?.id ? ctx.lists?.next(props.numbering) : undefined;

  // Reuse the last layout if nothing it depends on changed. Edits drop a paragraph's entry;
  // page-dependent layouts (headers and footers with page fields) aren't cached.
  const cache = ctx.fields ? undefined : ctx.paragraphCache;
  const key = cache ? `${ctx.fonts.pageVersion}.${ctx.fonts.mathVersion}|${width}|${layerKey(ctx)}|${ctx.background ?? ''}|${label ? `${label.level}:${label.text}:${label.suffix}` : ''}` : '';
  const cached = cache?.get(paragraph);
  if (cached && cached.key === key) return cached.layout;
  const layout = layoutParagraphUncached(paragraph, ctx, width, props, label);
  cache?.set(paragraph, { key, layout });
  return layout;
}

function layoutParagraphUncached(
  paragraph: Paragraph,
  ctx: LayoutContext,
  width: number,
  props: ParagraphProperties,
  label: import('@golemdocs/docx').ListLabel | undefined,
): ParagraphLayout {
  const resolver = ctx.resolver;
  const collector = new TextCollector(ctx, props.style);
  const markStyle = collector.style(props.runProperties ?? {});
  collector.inlines(paragraph.children);

  // List label, drawn in the paragraph mark's formatting plus the level's.
  let labelLength = 0;
  let boxLabel: 'unchecked' | 'checked' | undefined;
  if (label) {
    const level = resolver.listLevel(props.numbering!.id!, label.level);
    const labelProps = resolver.run(
      props.style,
      mergeProperties(mergeProperties({}, props.runProperties), level?.runProperties),
      ctx.layer,
    );
    const style = collector.resolvedStyle(labelProps);
    const suffix = label.suffix === 'tab' ? TAB : label.suffix === 'space' ? ' ' : '';
    // A check box is drawn, not typeset: its label is a space, and the box goes where the label starts.
    boxLabel = label.text === CHECKBOX.unchecked ? 'unchecked' : label.text === CHECKBOX.checked ? 'checked' : undefined;
    const text = (boxLabel ? '\u00a0' : TextCollector.labelText(label.text, collector.styles[style])) + suffix;
    collector.prepend(text, style);
    labelLength = text.length;
  }
  const { text, styleOf, styles, objects, maths, floats, ptabs, spans } = collector.finish();
  const n = text.length;

  // Faces used, including fallbacks: glyphs remember which one they came from.
  const fonts: ParagraphLayout['fonts'] = [];
  // Keyed by the font's own key, not its metrics: bold and regular text in a face with no bold (every
  // CJK page) share metrics but differ in what they draw (synthetic bold or slant).
  const fontIndex = new Map<string, number>();
  const fontOf = (font: ResolvedFont, metrics: FaceMetrics) => {
    let index = fontIndex.get(font.key);
    if (index === undefined) {
      index = fonts.length;
      fonts.push({ font, metrics });
      fontIndex.set(font.key, index);
    }
    return index;
  };

  // Equations, once the math font is loaded (until then they take no room).
  const mathFont = maths.size ? ctx.fonts.mathFont() : undefined;
  const mathMetrics = mathFont && ctx.fonts.metrics(mathFont.face);
  const mathData = ctx.fonts.mathData;
  const mathEngine = ctx.fonts.mathEngine;
  const mathLayouts = new Map<number, MathLayout>();
  if (mathMetrics && mathData && mathEngine) for (const [at, equation] of maths) mathLayouts.set(at, mathOf(equation, mathMetrics, mathData, mathEngine));

  // Per-character shaping: glyph, face, size and advance.
  const glyphs = new Int32Array(n);
  const faceOf = new Uint8Array(n);
  const sizes = new Float32Array(n);
  const advances = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const style = styles[styleOf[i]];
    let code = text.charCodeAt(i);
    let size = style.size;
    if (style.smallCaps && isLower(code)) {
      code = text[i].toUpperCase().charCodeAt(0);
      size *= 0.8;
    }
    sizes[i] = size;
    let metrics = style.metrics;
    let face = fontOf(style.font, metrics);
    let glyph = code < 0x20 || code === 0xfffc || code === 0xad ? -1 : metrics.glyph(code);
    if (glyph < 0 && code > 0x20 && code !== 0xfffc && code !== 0xad) {
      // Ordinary text never tries the CJK pages.
      const tries = isCjk(code) ? style.fallbacks.length : style.cjkStart;
      for (let f = 0; f < tries; f++) {
        const fallback = style.fallbacks[f];
        const g = fallback.metrics.glyph(code);
        if (g >= 0) {
          glyph = g;
          metrics = fallback.metrics;
          face = fontOf(fallback.font, metrics);
          break;
        }
      }
    }
    glyphs[i] = glyph;
    faceOf[i] = face;
    if (code === 0xfffc) advances[i] = mathLayouts.has(i) ? mathLayouts.get(i)!.width * size : (objects.get(i)?.width ?? 0) / 12700;
    else if (code === 0xad || code === 0x0a || code === 0x0c || code === 0x0b) advances[i] = 0;
    // Advances are floored to whole twips, as word processors lay text out in twips; this
    // decides line breaks on the last few points of a line.
    else advances[i] = Math.floor((metrics.advance(glyph) * size + style.letterSpacing) * 20) / 20;
    if (style.kerning && i > 0 && styleOf[i - 1] === styleOf[i]) {
      advances[i - 1] += metrics.kern(text.charCodeAt(i - 1), code) * size;
    }
  }

  // Geometry, in points relative to the column's left edge.
  const ind = props.indent ?? {};
  const left = twips(ind.left ?? ind.start);
  const right = twips(ind.right ?? ind.end);
  const firstLine = ind.hanging !== undefined ? -twips(ind.hanging) : twips(ind.firstLine);
  const rightEdge = width - right;
  const tabs: TabStop[] = (props.tabs ?? [])
    .filter((t) => t.val !== 'clear' && t.val !== 'bar' && t.pos !== undefined)
    .sort((a, b) => a.pos! - b.pos!);
  const defaultTab = ctx.defaultTabStop > 0 ? ctx.defaultTabStop : 36;
  // An equation alone in its paragraph, in display style, is centered.
  const soloDisplay = maths.size === 1 && n - labelLength === 1 && maths.values().next().value!.display;
  const justification = soloDisplay ? 'center' : (props.justification ?? 'left');
  const markMetrics = styles[markStyle];

  const tabAdvance = (i: number, x: number, first: boolean): { advance: number; leader?: string } => {
    let stop: TabStop | undefined = tabs.find((t) => twips(t.pos) > x + 0.01);
    let pos = stop ? twips(stop.pos) : Infinity;
    const ptab = ptabs.get(i);
    if (ptab) {
      const [from, to] = ptab.relativeTo === 'indent' ? [left, rightEdge] : [0, width];
      pos = ptab.alignment === 'center' ? (from + to) / 2 : ptab.alignment === 'right' ? to : from;
      stop = { val: ptab.alignment, pos: pos * 20, leader: ptab.leader as TabStop['leader'] };
    }
    // A hanging indent acts as a tab stop on the first line.
    if (!ptab && first && firstLine < 0 && x < left - 0.01 && left < pos) {
      pos = left;
      stop = undefined;
    }
    if (pos === Infinity) pos = (Math.floor(x / defaultTab + 1e-6) + 1) * defaultTab;
    const type = stop?.val ?? 'left';
    let advance = pos - x;
    if (type === 'right' || type === 'end' || type === 'center' || type === 'decimal') {
      let segment = 0;
      for (let j = i + 1; j < n; j++) {
        const c = text.charCodeAt(j);
        if (c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0b || (type === 'decimal' && c === 0x2e)) break;
        segment += advances[j];
      }
      advance = type === 'center' ? pos - x - segment / 2 : pos - x - segment;
    }
    return { advance: Math.max(advance, 0), leader: stop?.leader };
  };

  const lines: LineLayout[] = [];
  const leaders = new Map<number, string>();
  let lineTop = 0;
  let start = 0;
  // An empty paragraph, or a trailing line/page break, still produces a line for the mark.
  let needEmptyLine = n === 0;

  while (start < n || needEmptyLine) {
    needEmptyLine = false;
    const first = start === 0;
    const lineLeft = left + (first ? firstLine : 0);
    let x = lineLeft;
    let i = start;
    let lastBreak = -1;
    let breakType: 'none' | 'line' | 'page' | 'column' = 'none';
    leaders.clear();

    while (i < n) {
      const code = text.charCodeAt(i);
      if (code === 0x0a || code === 0x0c || code === 0x0b) {
        breakType = code === 0x0a ? 'line' : code === 0x0b ? 'column' : 'page';
        i++;
        break;
      }
      if (code === 0x09) {
        const tab = tabAdvance(i, x, first);
        advances[i] = tab.advance;
        if (tab.leader && tab.leader !== 'none') leaders.set(i, tab.leader);
      }
      const w = advances[i];
      if (code !== SPACE && x + w > rightEdge + 0.01 && i > start) {
        if (lastBreak >= start) i = lastBreak + 1;
        break;
      }
      x += w;
      if (isBreakAfter(code, i + 1 < n ? text.charCodeAt(i + 1) : 0)) lastBreak = i;
      i++;
    }
    const end = i;
    // A break at the very end of the paragraph leaves an empty line for the paragraph mark.
    if (end === n && breakType !== 'none') needEmptyLine = true;

    // Content extent: trailing spaces and break characters hang past the edge.
    let contentEnd = end;
    while (contentEnd > start) {
      const c = text.charCodeAt(contentEnd - 1);
      if (c === SPACE || c === 0x0a || c === 0x0c || c === 0x0b) contentEnd--;
      else break;
    }
    let contentWidth = 0;
    for (let j = start; j < contentEnd; j++) contentWidth += advances[j];

    // Alignment and justification.
    const available = rightEdge - lineLeft;
    let offset = 0;
    let extraPerSpace = 0;
    let justifyFrom = start;
    const lastLine = end === n && !needEmptyLine;
    if (justification === 'center') offset = (available - contentWidth) / 2;
    else if (justification === 'right' || justification === 'end') offset = available - contentWidth;
    else if ((justification === 'both' || justification === 'distribute') && (!lastLine || justification === 'distribute') && breakType !== 'page' && breakType !== 'column') {
      // Only spaces after the last tab stretch.
      for (let j = start; j < contentEnd; j++) if (text.charCodeAt(j) === 0x09) justifyFrom = j + 1;
      let spaces = 0;
      for (let j = justifyFrom; j < contentEnd; j++) if (text.charCodeAt(j) === SPACE) spaces++;
      if (spaces > 0 && available > contentWidth) extraPerSpace = (available - contentWidth) / spaces;
    }
    if (offset < 0) offset = 0;

    // Vertical metrics.
    let ascent = 0;
    let descent = 0;
    let objectHeight = 0;
    for (let j = start; j < Math.max(end, start + 1) && j < n; j++) {
      const style = styles[styleOf[j]];
      const size = sizes[j];
      ascent = Math.max(ascent, style.metrics.ascent * size + Math.max(style.rise, 0));
      descent = Math.max(descent, style.metrics.descent * size - Math.min(style.rise, 0));
      // A CJK page is taller than the Latin one (win ascent + descent about 1.45em against 1.22em).
      if (glyphs[j] >= 0) {
        const face = fonts[faceOf[j]];
        if (face.font.family.page) {
          ascent = Math.max(ascent, face.metrics.ascent * size + Math.max(style.rise, 0));
          descent = Math.max(descent, face.metrics.descent * size - Math.min(style.rise, 0));
        }
      }
      const math = mathLayouts.get(j);
      if (math) {
        ascent = Math.max(ascent, math.ascent * size + Math.max(style.rise, 0));
        descent = Math.max(descent, math.descent * size - Math.min(style.rise, 0));
      }
      // A picture is raised or lowered with its run, like text.
      if (text.charCodeAt(j) === 0xfffc) objectHeight = Math.max(objectHeight, (objects.get(j)?.height ?? 0) / 12700 + Math.max(style.rise, 0));
    }
    if (start >= n || end === start) {
      ascent = markMetrics.metrics.ascent * markMetrics.size;
      descent = markMetrics.metrics.descent * markMetrics.size;
    }
    const natural = Math.max(ascent, objectHeight) + descent;
    const spacing = props.spacing ?? {};
    const rule = spacing.lineRule ?? 'auto';
    let height = natural;
    // Multiple spacing scales the text's line height; an inline picture only needs its own height.
    if (rule === 'auto') height = Math.max((ascent + descent) * ((spacing.line ?? 240) / 240), natural);
    else if (rule === 'exact') height = twips(spacing.line);
    else if (rule === 'atLeast') height = Math.max(natural, twips(spacing.line));
    // Word puts the extra space of multiple/at-least spacing above the text.
    const baseline = height - descent;

    // Emit glyphs, decorations and objects.
    let pen = lineLeft + offset;
    let runStart = -1;
    let runX = 0;
    const flushDecorations = (toX: number) => {
      if (runStart < 0) return;
      const style = styles[styleOf[runStart]];
      const size = style.size;
      const base = baseline - style.rise;
      const w = toX - runX;
      if (style.highlight !== undefined || style.shading !== undefined) {
        const top = base - style.metrics.ascent * size;
        const h = (style.metrics.ascent + style.metrics.descent) * size;
        if (style.shading !== undefined) builder.rect(BEHIND, runX, top, w, h, style.shading);
        if (style.highlight !== undefined) builder.rect(BEHIND, runX, top, w, h, style.highlight);
      }
      if (style.underline) {
        const t = Math.max(style.metrics.underlineThickness * size, 0.5);
        const y = base + style.metrics.underlinePosition * size;
        builder.rect(OVER, runX, y - t / 2, w, t, style.underline.color);
        if (style.underline.style === 'double') builder.rect(OVER, runX, y + t * 1.5, w, t, style.underline.color);
      }
      if (style.strike || style.doubleStrike) {
        const t = Math.max(style.metrics.strikeoutThickness * size, 0.5);
        const y = base - style.metrics.strikeoutPosition * size;
        if (style.doubleStrike) {
          builder.rect(OVER, runX, y - t * 1.5, w, t, style.color);
          builder.rect(OVER, runX, y + t * 0.5, w, t, style.color);
        } else builder.rect(OVER, runX, y - t / 2, w, t, style.color);
      }
      runStart = -1;
    };

    // Caret stops for the visible offsets on this line (the list label has none).
    const firstVisible = Math.max(start, labelLength);
    const stops = new Float32Array(Math.max(end - firstVisible, 0) + 1);
    for (let j = start; j < end; j++) {
      if (j >= firstVisible) stops[j - firstVisible] = pen;
      const code = text.charCodeAt(j);
      let w = advances[j];
      if (code === SPACE && j >= justifyFrom && j < contentEnd) w += extraPerSpace;
      const s = styleOf[j];
      if (j === contentEnd) flushDecorations(pen);
      if (j < contentEnd && (runStart < 0 || styleOf[runStart] !== s)) {
        flushDecorations(pen);
        runStart = j;
        runX = pen;
      }
      if (boxLabel && j === 0) {
        builder.box = checkbox((rx, ry, rw, rh, c) => builder.rect(OVER, rx, ry, rw, rh, c), pen, baseline, sizes[j], styles[s].color, boxLabel === 'checked');
      } else if (glyphs[j] >= 0 && fonts[faceOf[j]].metrics.visible[glyphs[j]]) {
        builder.glyph.push(glyphs[j]);
        builder.x.push(pen);
        builder.style.push(s);
        builder.size.push(sizes[j]);
        builder.dy.push(0);
        builder.font.push(faceOf[j]);
      } else if (code === 0xfffc && mathLayouts.has(j)) {
        const math = mathLayouts.get(j)!;
        const size = sizes[j];
        const mathFace = fontOf(mathFont!, mathMetrics!);
        for (const g of math.glyphs) {
          if (!mathMetrics!.visible[g.glyph]) continue;
          builder.glyph.push(g.glyph);
          builder.x.push(pen + g.x * size);
          builder.style.push(s);
          builder.size.push(g.size * size);
          builder.dy.push(g.y * size);
          builder.font.push(mathFace);
        }
        for (const r of math.rules) builder.rect(OVER, pen + r.x * size, baseline - styles[s].rise + r.y * size, r.width * size, r.height * size, styles[s].color);
      } else if (code === 0xfffc) {
        const d = objects.get(j);
        const h = (d?.height ?? 0) / 12700;
        if (d?.image) builder.images.push({ part: d.image, x: pen, y: baseline - h - styles[s].rise, width: w, height: h });
      } else if (code === 0x09 && leaders.has(j)) {
        const leader = leaders.get(j)!;
        const style = styles[s];
        if (leader === 'underscore' || leader === 'heavy') {
          const t = Math.max(style.metrics.underlineThickness * style.size, 0.5) * (leader === 'heavy' ? 2 : 1);
          builder.rect(OVER, pen, baseline + style.metrics.underlinePosition * style.size, w, t, style.color);
        } else {
          const char = leader === 'hyphen' ? 0x2d : leader === 'middleDot' ? 0xb7 : 0x2e;
          const g = style.metrics.glyph(char);
          const step = style.metrics.advance(g) * style.size;
          if (g >= 0 && step > 0) {
            // Leader dots sit on a grid so they line up between lines.
            for (let lx = Math.ceil((pen + step * 0.5) / step) * step; lx + step <= pen + w - step * 0.5; lx += step) {
              builder.glyph.push(g);
              builder.x.push(lx);
              builder.style.push(s);
              builder.size.push(style.size);
              builder.dy.push(0);
              builder.font.push(fontOf(style.font, style.metrics));
            }
          }
        }
      }
      pen += w;
    }
    stops[stops.length - 1] = end >= firstVisible ? pen : lineLeft + offset;
    flushDecorations(pen);

    // Paragraph shading and borders, per line so they follow page breaks.
    const shadingFill = props.shading?.fill;
    const paragraphFill = shadingFill && shadingFill !== 'auto' ? parseHexColor(shadingFill) : undefined;
    if (paragraphFill !== undefined) builder.rect(BEHIND, left, 0, rightEdge - left, height, paragraphFill);
    const borders = props.borders;
    if (borders) {
      const stroke = (b: Border | undefined) =>
        b && b.val && b.val !== 'nil' && b.val !== 'none' ? { w: Math.max((b.sz ?? 4) / 8, 0.25), color: parseHexColor(b.color) ?? BLACK, space: b.space ?? 0 } : undefined;
      const l = stroke(borders.left);
      const r = stroke(borders.right);
      if (l) builder.rect(OVER, left - l.space - l.w, 0, l.w, height, l.color);
      if (r) builder.rect(OVER, rightEdge + r.space, 0, r.w, height, r.color);
      const t = first ? stroke(borders.top) : undefined;
      if (t) builder.rect(OVER, left - (l ? l.space + l.w : 0), -t.space - t.w, rightEdge - left + (l ? l.space + l.w : 0) + (r ? r.space + r.w : 0), t.w, t.color);
      if (lastLine) {
        const b = stroke(borders.bottom);
        if (b) builder.rect(OVER, left - (l ? l.space + l.w : 0), height + b.space, rightEdge - left + (l ? l.space + l.w : 0) + (r ? r.space + r.w : 0), b.w, b.color);
      }
    }

    lines.push(
      builder.finish({
        y: lineTop,
        height,
        baseline,
        start: Math.max(0, start - labelLength),
        end: Math.max(0, end - labelLength),
        left: lineLeft + offset,
        width: contentWidth,
        pageBreak: breakType === 'page' || breakType === 'column',
        columnBreak: breakType === 'column',
        trailingSpace: !lastLine && end > firstVisible && (text.charCodeAt(end - 1) === SPACE || breakType !== 'none'),
      }, stops),
    );
    lineTop += height;
    start = end;
  }

  const spacing = props.spacing ?? {};
  return {
    paragraph,
    properties: props,
    lines,
    styles,
    fonts,
    height: lineTop,
    spaceBefore: spacing.beforeAutospacing ? 14 : twips(spacing.before),
    spaceAfter: spacing.afterAutospacing ? 14 : twips(spacing.after),
    keepNext: props.keepNext ?? false,
    keepLines: props.keepLines ?? false,
    widowControl: props.widowControl ?? false,
    pageBreakBefore: props.pageBreakBefore ?? false,
    contextualSpacing: props.contextualSpacing ?? false,
    styleId: props.style,
    floats: floats.map(readFloat),
    section: paragraph.properties.section,
    spans,
    length: n - labelLength,
  };
}

/** Draws a laid-out line onto a page at (x, y) = column left and line top, in page points. */
export function emitLine(
  page: import('./display.ts').PageLayout,
  paragraph: ParagraphLayout,
  line: LineLayout,
  x: number,
  y: number,
  /** The column's width, when the page has columns. */
  columnWidth?: number,
): void {
  const { styles, fonts } = paragraph;
  for (let i = 0; i < line.glyph.length; i++) {
    const style = styles[line.style[i]];
    const face = fonts[line.font[i]];
    page
      .glyphList(face.font, face.metrics)
      .push(x + line.x[i], y + line.baseline - style.rise + line.dy[i], line.size[i], line.glyph[i], style.color);
  }
  for (let r = 0; r < line.rectColors.length; r++) {
    const target = line.rectLayers[r] === BEHIND ? page.background : page.foreground;
    target.push(x + line.rects[r * 4], y + line.rects[r * 4 + 1], line.rects[r * 4 + 2], line.rects[r * 4 + 3], line.rectColors[r]);
  }
  for (const image of line.images) {
    page.images.push({ part: image.part, x: x + image.x, y: y + image.y, width: image.width, height: image.height, behind: false });
  }
  page.lines.push({
    paragraph: paragraph.paragraph,
    start: line.start,
    end: line.end,
    x: x + line.left,
    y,
    width: line.width,
    height: line.height,
    baseline: line.baseline,
    column: x,
    columnWidth,
    stops: line.stops,
    box: line.box,
    spans: paragraph.spans,
    trailingSpace: line.trailingSpace,
    last: line === paragraph.lines[paragraph.lines.length - 1],
  });
  if (formattingMarksOn()) emitMarks(page, paragraph, line, x, y);
}
