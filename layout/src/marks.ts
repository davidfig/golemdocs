// Formatting marks (Word's ¶ button): the paragraph mark at the end of each paragraph, a dot for each
// space, an arrow for each tab and a hook for each line break. They are drawn in the text's own
// font at layout time, as glyphs on the page (the renderer doesn't know they are there), and
// change nothing about how the text is laid out. Turning them on or off lays the pages out again.

import type { Inline, Paragraph } from '@word/docx';
import { OBJECT_CHAR } from '@word/docx';
import { packColor, type PageLayout } from './display.ts';
import { modelOfChar } from './offsets.ts';
import type { LineLayout, ParagraphLayout } from './paragraph.ts';

let on = false;

/** Whether marks are drawn on pages laid out from now on. */
export const formattingMarksOn = (): boolean => on;

/** Turns marks on or off. The caller lays the document out again. */
export function setFormattingMarks(value: boolean): void {
  on = value;
}

/** A blue-gray that reads as an annotation, not as text. */
const MARK_COLOR = packColor(0x5b7fa6);
const PARAGRAPH_MARK = 0xb6; // ¶
const SPACE_MARK = 0xb7; // ·
const NO_BREAK_SPACE_MARK = 0xb0; // °
const TAB_MARK = 0x2192; // →
const LINE_BREAK_MARK = 0xac; // ¬

/** What is at each model offset of a paragraph: its text, and \t for a tab, \n for a line break, \f for a page or column break. */
function charsOf(paragraph: Paragraph): string {
  const out: string[] = [];
  const walk = (inlines: readonly Inline[]): void => {
    for (const inline of inlines) {
      if (inline.kind === 'run') {
        for (const item of inline.content) {
          if (item.kind === 'text' || item.kind === 'delText' || item.kind === 'instrText') out.push(item.text);
          else if (item.kind === 'tab') out.push('\t');
          else if (item.kind === 'break') out.push(item.type === 'page' || item.type === 'column' ? '\f' : '\n');
          else if (item.kind === 'cr') out.push('\n');
          else out.push(OBJECT_CHAR);
        }
      } else if (inline.kind === 'raw') out.push(OBJECT_CHAR);
      else walk(inline.children);
    }
  };
  walk(paragraph.children);
  return out.join('');
}

/** Draws the marks of one line onto the page: `x` is the column's left edge and `y` the line's top (page points). */
export function emitMarks(page: PageLayout, paragraph: ParagraphLayout, line: LineLayout, x: number, y: number): void {
  // The last style is the one the paragraph mark itself has (an empty paragraph has only that).
  const style = paragraph.styles[paragraph.styles.length - 1];
  if (!style) return;
  // Marks take the face and size of the line's first text glyph, not of an equation's (the math font has no marks).
  let first = -1;
  for (let i = 0; i < line.glyph.length && first < 0; i++) if (!paragraph.fonts[line.font[i]].font.family.math) first = i;
  const face = (first >= 0 ? paragraph.fonts[line.font[first]] : undefined) ?? paragraph.fonts.find((f) => !f.font.family.math) ?? { font: style.font, metrics: style.metrics };
  const { metrics } = face;
  const size = first >= 0 ? line.size[first] : style.size;
  const baseline = y + line.baseline;
  const list = page.glyphList(face.font, metrics);

  /** A mark glyph left-aligned at x0, or centered between x0 and x1; false if the face doesn't have it. */
  const draw = (codepoint: number, x0: number, x1?: number): boolean => {
    const glyph = metrics.glyph(codepoint);
    if (glyph < 0) return false;
    const width = metrics.advance(glyph) * size;
    list.push(x1 === undefined ? x0 : (x0 + x1 - width) / 2, baseline, size, glyph, MARK_COLOR);
    return true;
  };

  const chars = paragraph.paragraph.children.length ? charsOf(paragraph.paragraph) : '';
  for (let visible = line.start; visible < line.end; visible++) {
    const char = chars[modelOfChar(paragraph.spans, visible)];
    const x0 = x + line.stops[visible - line.start];
    const x1 = x + line.stops[visible + 1 - line.start];
    if (char === ' ') draw(SPACE_MARK, x0, x1);
    else if (char === ' ') draw(NO_BREAK_SPACE_MARK, x0, x1);
    else if (char === '\n') draw(LINE_BREAK_MARK, x0);
    else if (char === '\t') {
      // An arrow across the tab's width; a plain line where the face has no arrow.
      if (!draw(TAB_MARK, x0) && x1 - x0 > 2) page.foreground.push(x0 + 1, baseline - size * 0.28, x1 - x0 - 2, Math.max(size * 0.05, 0.5), MARK_COLOR);
    }
  }
  // The paragraph mark, after the last line's text.
  if (line === paragraph.lines[paragraph.lines.length - 1]) draw(PARAGRAPH_MARK, x + line.stops[line.end - line.start]);
}
