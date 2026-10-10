// Moving the caret, and caret and selection geometry from the laid-out lines.
import { type Position, type MoveTarget, type Rect, type Caret, type SelectionGeometry } from './types.ts';
import type { Selection as OpSelection } from '@golemdocs/ops';

import { paragraphLength, paragraphText, plainText, splitInlines, type Paragraph } from '@golemdocs/docx';
import { type Pos } from '@golemdocs/ops';
import { graphemeAt } from './segment.ts';
import { charAfter, charBefore, wordLeft, wordRange, wordRight } from './textUnits.ts';
import { toModel, toVisible, visibleLength, type LineRecord, type PageLayout, type SourceSpan } from '@golemdocs/layout';
import { EditorBase } from './base.ts';

/** Width shown for a selected paragraph mark, points. */
const MARK_WIDTH = 4;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

function charRange(spans: readonly SourceSpan[], visible: number): [number, number] {
  let s = spans[0];
  for (const span of spans) {
    if (span.visible > visible) break;
    s = span;
  }
  if (s.text) {
    const from = s.model + (visible - s.visible);
    return [from, from + 1];
  }
  return [s.model, s.model + s.modelLength];
}

export abstract class EditorNavigation extends EditorBase {
  /** Caret geometry at a position given by ids (someone else's caret), if that's laid out. */
  caretAt(pos: Pos): Caret | null {
    const position = this.position(pos);
    if (!position) return null;
    const hint = this.hint;
    const caret = this.caret(position);
    this.hint = hint;
    return caret;
  }

  /** Highlight rectangles for someone else's selection, given by ids (none if it is only a caret, or not laid out). */
  rectsFor(selection: OpSelection): Rect[] {
    const a = this.position(selection.anchor);
    const b = this.position(selection.focus);
    if (!a || !b) return [];
    const [start, end] = this.compare(a, b) <= 0 ? [a, b] : [b, a];
    if (start.paragraph === end.paragraph && start.offset === end.offset) return [];
    const hint = this.hint;
    const rects = this.rangeRects(start, end);
    this.hint = hint;
    return rects;
  }

  protected move(to: MoveTarget, extend: boolean): void {
    const focus = this.selection.focus;
    if (!extend && !this.collapsed && (to === 'left' || to === 'right')) {
      const [start, end] = this.ordered();
      this.collapse(to === 'left' ? start : end);
      return;
    }
    let next: Position | null = null;
    switch (to) {
      case 'left':
        next = this.step(focus, -1) ?? this.paragraphEdge(focus, -1);
        break;
      case 'right':
        next = this.step(focus, 1) ?? this.paragraphEdge(focus, 1);
        break;
      case 'wordLeft':
        next = this.wordLeft(focus);
        break;
      case 'wordRight':
        next = this.wordRight(focus);
        break;
      case 'up':
      case 'down':
        next = this.vertical(focus, to === 'up' ? -1 : 1);
        break;
      case 'lineStart':
      case 'lineEnd': {
        const at = this.caretLine(focus);
        if (at) {
          const { line } = at;
          const v = to === 'lineStart' ? line.start : line.trailingSpace ? line.end - 1 : line.end;
          next = { paragraph: line.paragraph, offset: toModel(line.spans, v) };
        }
        break;
      }
      case 'documentStart':
        next = { paragraph: this.paragraphs()[0], offset: 0 };
        break;
      case 'documentEnd': {
        const list = this.paragraphs();
        const last = list[list.length - 1];
        next = { paragraph: last, offset: paragraphLength(last) };
        break;
      }
    }
    if (!next) return;
    if (extend) this.selection = { anchor: this.selection.anchor, focus: next };
    else this.collapse(next);
  }

  /** Start of the next paragraph or end of the previous one. */
  protected paragraphEdge(pos: Position, dir: -1 | 1): Position | null {
    const p = this.paragraphs()[this.indexOf(pos.paragraph) + dir];
    if (!p) return null;
    return { paragraph: p, offset: dir < 0 ? paragraphLength(p) : 0 };
  }

  protected spans(p: Paragraph): SourceSpan[] | null {
    return this.session.linesOf(p, this.hint)[0]?.line.spans ?? null;
  }

  /** One visible character left or right within the paragraph, or null at its edge. */
  protected step(pos: Position, dir: -1 | 1): Position | null {
    const range = dir < 0 ? this.charBefore(pos) : this.charAfter(pos);
    if (!range) return null;
    return { paragraph: pos.paragraph, offset: dir < 0 ? range[0] : range[1] };
  }

  /** Model range of the visible character before a position (null at the start). */
  protected charBefore(pos: Position): [number, number] | null {
    const spans = this.spans(pos.paragraph);
    const text = paragraphText(pos.paragraph);
    if (!spans) {
      if (pos.offset <= 0) return null;
      return [charBefore(text, pos.offset), pos.offset];
    }
    const v = toVisible(spans, pos.offset);
    if (v <= 0) return null;
    const range = charRange(spans, v - 1);
    if (range[1] - range[0] === 1 && range[0] > 0 && isLow(text.charCodeAt(range[0])) && isHigh(text.charCodeAt(range[0] - 1))) range[0]--;
    range[0] = Math.min(range[0], graphemeAt(text, range[1] - 1)?.[0] ?? range[0]);
    return range;
  }

  /** Model range of the visible character after a position (null at the end). */
  protected charAfter(pos: Position): [number, number] | null {
    const spans = this.spans(pos.paragraph);
    const text = paragraphText(pos.paragraph);
    if (!spans) {
      if (pos.offset >= text.length) return null;
      return [pos.offset, charAfter(text, pos.offset)];
    }
    const v = toVisible(spans, pos.offset);
    if (v >= visibleLength(spans)) return null;
    const range = charRange(spans, v);
    if (range[1] - range[0] === 1 && isHigh(text.charCodeAt(range[0])) && isLow(text.charCodeAt(range[1]))) range[1]++;
    range[1] = Math.max(range[1], graphemeAt(text, range[0])?.[1] ?? range[1]);
    return range;
  }

  /** Start of this or the previous word (across a paragraph start). */
  protected wordLeft(pos: Position): Position {
    if (pos.offset === 0) return this.paragraphEdge(pos, -1) ?? pos;
    return { paragraph: pos.paragraph, offset: wordLeft(paragraphText(pos.paragraph), pos.offset) };
  }

  /** Start of the next word (across a paragraph end). */
  protected wordRight(pos: Position): Position {
    const text = paragraphText(pos.paragraph);
    if (pos.offset >= text.length) return this.paragraphEdge(pos, 1) ?? pos;
    return { paragraph: pos.paragraph, offset: wordRight(text, pos.offset) };
  }

  /** The word (or run of spaces, or single character) around a position. */
  protected wordAt(pos: Position): [Position, Position] {
    const [a, b] = wordRange(paragraphText(pos.paragraph), pos.offset);
    return [
      { paragraph: pos.paragraph, offset: a },
      { paragraph: pos.paragraph, offset: b },
    ];
  }

  /** The line a position is on (at a wrap point, the start of the next line). */
  protected caretLine(pos: Position): { page: PageLayout; line: LineRecord; v: number } | null {
    const lines = this.session.linesOf(pos.paragraph, this.hint);
    if (lines.length === 0) return null;
    const v = toVisible(lines[0].line.spans, pos.offset);
    for (let i = 0; i < lines.length; i++) {
      const { line } = lines[i];
      if (v >= line.start && (v < line.end || i === lines.length - 1)) return { ...lines[i], v: Math.min(v, line.end) };
    }
    return { ...lines[lines.length - 1], v };
  }

  caret(pos: Position): Caret | null {
    const at = this.caretLine(pos);
    if (!at) return null;
    const { page, line, v } = at;
    const shown = this.session.displayPages;
    const index = shown[page.index] === page ? page.index : shown.indexOf(page);
    if (index >= 0) this.hint = index;
    return { page, x: line.column + line.stops[Math.max(0, Math.min(v - line.start, line.stops.length - 1))], y: line.y, height: line.height };
  }

  /** The line above or below at the goal x. */
  protected vertical(pos: Position, dir: -1 | 1): Position | null {
    const at = this.caretLine(pos);
    if (!at) return null;
    const caret = this.caret(pos)!;
    this.goalX ??= caret.x;
    const goal = this.goalX;
    const shown = this.session.displayPages;
    let pageIndex = shown.indexOf(at.page);
    const current = at.line;
    for (let tries = 0; pageIndex >= 0 && pageIndex < shown.length && tries < 3; tries++, pageIndex += dir) {
      const page = shown[pageIndex];
      let candidates = page.lines;
      if (page === at.page) {
        candidates = candidates.filter((l) =>
          dir < 0 ? l.y + l.height <= current.y + 0.01 && l !== current : l.y >= current.y + current.height - 0.01 && l !== current,
        );
      }
      // Past the end of a column of text: on to the next column (or back to the one before).
      if (page === at.page && current.columnWidth !== undefined && !candidates.some((l) => goal >= l.column - 1 && goal <= l.column + (l.columnWidth ?? 0) + 1)) {
        const next = page.lines[page.lines.indexOf(current) + dir];
        if (next && next.columnWidth !== undefined && next.column !== current.column) return this.positionInLine(next, goal);
      }
      if (candidates.length === 0) continue;
      // Stay in the same column (table cells) when a line there qualifies. A column is as wide as its widest line, so a short or empty line is still in the column its text is in.
      const extent = new Map<number, number>();
      for (const l of page.lines) extent.set(l.column, Math.max(extent.get(l.column) ?? 0, l.width + (l.x - l.column)));
      const inColumn = candidates.filter((l) => goal >= l.column - 1 && goal <= l.column + (extent.get(l.column) ?? 0) + 1);
      const pool = inColumn.length ? inColumn : candidates;
      const best = pool.reduce((a, b) => (dir < 0 ? (b.y + b.height > a.y + a.height ? b : a) : b.y < a.y ? b : a));
      return this.positionInLine(best, goal);
    }
    return dir < 0 ? { paragraph: this.paragraphs()[0], offset: 0 } : null;
  }

  protected positionInLine(line: LineRecord, x: number): Position {
    let k = 0;
    let best = Infinity;
    for (let i = 0; i < line.stops.length; i++) {
      const d = Math.abs(line.column + line.stops[i] - x);
      if (d < best) {
        best = d;
        k = i;
      }
    }
    let v = line.start + k;
    // Past the end of a wrapped line: stay on it (before the space it wrapped at).
    if (v === line.end && !line.last && line.trailingSpace) v--;
    return { paragraph: line.paragraph, offset: toModel(line.spans, v) };
  }

  /** The position at page-relative points (nearest line, nearest caret stop). */
  hitTest(page: PageLayout, x: number, y: number): Position | null {
    const lines = page.lines;
    if (lines.length === 0) return null;
    const horizontal = (l: LineRecord) => (x < l.x ? l.x - x : x > l.x + l.width ? x - l.x - l.width : 0);
    const vertical = (l: LineRecord) => (y < l.y ? l.y - y : y > l.y + l.height ? y - l.y - l.height : 0);
    // With columns, a click belongs to the column it is in, even below where that column's text ends.
    const inColumn = lines.filter((l) => l.columnWidth !== undefined && x >= l.column && x <= l.column + l.columnWidth);
    let best = lines[0];
    let bestScore = Infinity;
    for (const l of inColumn.length ? inColumn : lines) {
      const score = vertical(l) * 1000 + horizontal(l);
      if (score < bestScore) {
        best = l;
        bestScore = score;
      }
    }
    return this.positionInLine(best, x);
  }

  /** The selected text, for the clipboard (paragraphs separated by newlines). */
  selectedText(limit = Infinity): string {
    if (this.collapsed) return '';
    const [start, end] = this.ordered();
    if (start.paragraph === end.paragraph) return plainText(start.paragraph, start.offset, end.offset);
    const list = this.paragraphs();
    const parts = [plainText(start.paragraph, start.offset)];
    let size = parts[0].length;
    for (let k = this.indexOf(start.paragraph) + 1; k < this.indexOf(end.paragraph) && size < limit; k++) {
      parts.push(plainText(list[k]));
      size += parts[parts.length - 1].length + 1;
    }
    parts.push(plainText(end.paragraph, 0, end.offset));
    const text = parts.join('\n');
    return text.length > limit ? text.slice(0, limit) : text;
  }

  /** The selected paragraphs with their formatting, the first and last cut to the selection (for the clipboard's HTML). Empty when nothing is selected. */
  selectedFragments(): Paragraph[] {
    if (this.collapsed) return [];
    const [start, end] = this.ordered();
    const cut = (p: Paragraph, from: number, to: number): Paragraph => {
      const [, tail] = splitInlines(p.children, from);
      const [children] = splitInlines(tail, to - from);
      return structuredClone({ ...p, children });
    };
    if (start.paragraph === end.paragraph) return [cut(start.paragraph, start.offset, end.offset)];
    const list = this.paragraphs();
    const out = [cut(start.paragraph, start.offset, paragraphLength(start.paragraph))];
    for (let k = this.indexOf(start.paragraph) + 1; k < this.indexOf(end.paragraph); k++) out.push(structuredClone(list[k]));
    out.push(cut(end.paragraph, 0, end.offset));
    return out;
  }

  /** Caret or highlight for the current selection, on the session's display pages. */
  geometry(): SelectionGeometry {
    const focus = this.caret(this.selection.focus);
    if (this.collapsed) return { caret: focus, rects: [], focus };
    return { caret: null, rects: this.selectionRects(), focus };
  }

  protected selectionRects(): Rect[] {
    const [start, end] = this.ordered();
    return this.rangeRects(start, end);
  }

  /** Highlight rectangles over the text from `start` to `end` (in document order). */
  protected rangeRects(start: Position, end: Position): Rect[] {
    const ia = this.indexOf(start.paragraph);
    const ib = this.indexOf(end.paragraph);
    const first = this.session.linesOf(start.paragraph, this.hint)[0];
    if (!first) return [];
    const shown = this.session.displayPages;
    const rects: Rect[] = [];
    for (let i = Math.max(shown.indexOf(first.page), 0); i < shown.length; i++) {
      const page = shown[i];
      let lowest = Infinity;
      for (const line of page.lines) {
        const k = this.indexOf(line.paragraph);
        if (k < 0) continue;
        lowest = Math.min(lowest, k);
        if (k < ia || k > ib) continue;
        const from = k === ia ? toVisible(line.spans, start.offset) : 0;
        const to = k === ib ? toVisible(line.spans, end.offset) : Infinity;
        const a = Math.max(from, line.start);
        const b = Math.min(to, line.end);
        if (a > b || (a === b && to <= line.end)) continue;
        const x1 = line.column + line.stops[a - line.start];
        let x2 = line.column + line.stops[b - line.start];
        // The paragraph mark is selected too when the selection goes past it.
        if (to > line.end && line.last) x2 += MARK_WIDTH;
        if (x2 > x1) rects.push({ page, x: x1, y: line.y, width: x2 - x1, height: line.height });
      }
      if (lowest > ib && lowest !== Infinity) break;
    }
    return rects;
  }
}
