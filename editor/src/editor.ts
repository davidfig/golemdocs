// Editing: a selection in model positions, commands that edit the model (and tell layout
// what changed), and caret/selection geometry from the laid-out lines.
//
// Everything is addressed in model offsets (see @word/docx edit/text.ts), not in laid-out
// text, so commands can be replayed on another client or a server and positions stay put
// when layout changes. Visible offsets only appear when talking to layout (stepping over
// hidden text, caret x positions).

import {
  deleteText,
  findContainer,
  insertBlockAfter,
  insertItem,
  insertText,
  mergeParagraphs,
  paragraphLength,
  paragraphsIn,
  paragraphText,
  plainText,
  removeBlock,
  splitParagraph,
  type Block,
  type Paragraph,
  type WordDocument,
} from '@word/docx';
import { toModel, toVisible, visibleLength, type LayoutSession, type LineRecord, type PageLayout, type SourceSpan } from '@word/layout';

/** A position between two model positions of a paragraph. */
export interface Position {
  paragraph: Paragraph;
  offset: number;
}

/** Anchor stays put while extending; focus is where the caret is. */
export interface Selection {
  anchor: Position;
  focus: Position;
}

export type MoveTarget =
  | 'left'
  | 'right'
  | 'wordLeft'
  | 'wordRight'
  | 'up'
  | 'down'
  | 'lineStart'
  | 'lineEnd'
  | 'documentStart'
  | 'documentEnd';

export type Command =
  | { kind: 'insertText'; text: string }
  | { kind: 'insertParagraph' }
  | { kind: 'insertLineBreak' }
  | { kind: 'delete'; direction: 'backward' | 'forward'; unit?: 'character' | 'word' }
  | { kind: 'move'; to: MoveTarget; extend?: boolean }
  /** A click or drag at page-relative points; `unit` selects a word or paragraph (double/triple click). */
  | { kind: 'pointer'; page: PageLayout; x: number; y: number; extend?: boolean; unit?: 'character' | 'word' | 'paragraph' }
  | { kind: 'selectAll' };

export interface Rect {
  page: PageLayout;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Caret {
  page: PageLayout;
  x: number;
  y: number;
  height: number;
}

export interface SelectionGeometry {
  /** The caret, when the selection is collapsed. */
  caret: Caret | null;
  /** Highlight rectangles, when it isn't. */
  rects: Rect[];
  /** Where the focus is (to scroll it into view). */
  focus: Caret | null;
}

/** Width shown for a selected paragraph mark, points. */
const MARK_WIDTH = 4;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const WORD = /[\p{L}\p{N}_'’]/u;
const SPACE = /\s/u;

export class Editor {
  selection: Selection;
  /** x the caret tries to keep while moving up and down. */
  private goalX: number | null = null;
  private order: Map<Paragraph, number> | null = null;
  private list: Paragraph[] = [];
  /** Display page index near the caret, to find lines quickly. */
  private hint = 0;

  constructor(
    readonly doc: WordDocument,
    readonly session: LayoutSession,
  ) {
    let first = this.paragraphs()[0];
    if (!first) {
      first = { kind: 'paragraph', properties: {}, children: [], attrs: {} };
      doc.body.push(first);
      this.structureChanged();
      session.invalidate([first], { structural: true });
    }
    this.selection = { anchor: { paragraph: first, offset: 0 }, focus: { paragraph: first, offset: 0 } };
  }

  // --- Document order --------------------------------------------------------------------

  /** Body paragraphs in document order (including those in tables). */
  paragraphs(): Paragraph[] {
    if (!this.order) {
      this.list = paragraphsIn(this.doc.body);
      this.order = new Map(this.list.map((p, i) => [p, i]));
    }
    return this.list;
  }

  private indexOf(p: Paragraph): number {
    this.paragraphs();
    return this.order!.get(p) ?? -1;
  }

  private structureChanged(): void {
    this.order = null;
  }

  private compare(a: Position, b: Position): number {
    const ia = this.indexOf(a.paragraph);
    const ib = this.indexOf(b.paragraph);
    return ia !== ib ? ia - ib : a.offset - b.offset;
  }

  get collapsed(): boolean {
    const { anchor, focus } = this.selection;
    return anchor.paragraph === focus.paragraph && anchor.offset === focus.offset;
  }

  /** Selection start and end in document order. */
  ordered(): [Position, Position] {
    const { anchor, focus } = this.selection;
    return this.compare(anchor, focus) <= 0 ? [anchor, focus] : [focus, anchor];
  }

  private collapse(position: Position): void {
    this.selection = { anchor: { ...position }, focus: { ...position } };
  }

  // --- Commands --------------------------------------------------------------------------

  /** Applies a command. Edits invalidate the session; run it afterwards to update layout. */
  apply(command: Command): { edited: boolean } {
    if (command.kind !== 'move' || (command.to !== 'up' && command.to !== 'down')) this.goalX = null;
    const edit = new EditSet();
    switch (command.kind) {
      case 'insertText':
        this.deleteSelection(edit);
        this.insert(command.text, edit);
        break;
      case 'insertParagraph':
        this.deleteSelection(edit);
        this.collapse(this.split(this.selection.focus, edit));
        break;
      case 'insertLineBreak': {
        this.deleteSelection(edit);
        const { paragraph, offset } = this.selection.focus;
        insertItem(paragraph, offset, { kind: 'break' });
        edit.changed.add(paragraph);
        this.collapse({ paragraph, offset: offset + 1 });
        break;
      }
      case 'delete':
        if (!this.collapsed) this.deleteSelection(edit);
        else if (command.direction === 'backward') this.deleteBackward(command.unit ?? 'character', edit);
        else this.deleteForward(command.unit ?? 'character', edit);
        break;
      case 'move':
        this.move(command.to, command.extend ?? false);
        break;
      case 'pointer':
        this.pointer(command);
        break;
      case 'selectAll': {
        const list = this.paragraphs();
        const last = list[list.length - 1];
        this.selection = { anchor: { paragraph: list[0], offset: 0 }, focus: { paragraph: last, offset: paragraphLength(last) } };
        break;
      }
    }
    if (edit.changed.size === 0 && !edit.structural) return { edited: false };
    if (edit.structureChanged) this.structureChanged();
    this.session.invalidate(edit.changed, { structural: edit.structural });
    return { edited: true };
  }

  private insert(text: string, edit: EditSet): void {
    let pos = this.selection.focus;
    text.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
      if (i > 0) pos = this.split(pos, edit);
      line.split('\t').forEach((part, j) => {
        if (j > 0) {
          insertItem(pos.paragraph, pos.offset, { kind: 'tab' });
          pos = { paragraph: pos.paragraph, offset: pos.offset + 1 };
        }
        if (part) {
          insertText(pos.paragraph, pos.offset, part);
          pos = { paragraph: pos.paragraph, offset: pos.offset + part.length };
        }
      });
      edit.changed.add(pos.paragraph);
    });
    this.collapse(pos);
  }

  /** Splits a paragraph (Enter); returns the start of the new one. */
  private split(pos: Position, edit: EditSet): Position {
    const container = this.containerOf(pos.paragraph);
    const hadSection = !!pos.paragraph.properties.section;
    const next = splitParagraph(pos.paragraph, pos.offset, this.doc.styles);
    insertBlockAfter(container, pos.paragraph, next);
    edit.changed.add(pos.paragraph);
    edit.changed.add(next);
    edit.structureChanged = true;
    if (hadSection) edit.structural = true;
    this.structureChanged();
    return { paragraph: next, offset: 0 };
  }

  private containerOf(p: Paragraph): Block[] {
    const container = findContainer(this.doc.body, p);
    if (!container) throw new Error('paragraph is not in the document body');
    return container;
  }

  /** Merges `second` into `first` if they're neighbors in one container. */
  private merge(first: Paragraph, second: Paragraph, edit: EditSet): boolean {
    const container = this.containerOf(second);
    if (container[container.indexOf(second) - 1] !== first) return false;
    if (first.properties.section || second.properties.section) edit.structural = true;
    mergeParagraphs(first, second);
    removeBlock(container, second);
    edit.changed.add(first);
    edit.structureChanged = true;
    this.structureChanged();
    return true;
  }

  private deleteSelection(edit: EditSet): void {
    if (this.collapsed) return;
    const [start, end] = this.ordered();
    const a = start.paragraph;
    const b = end.paragraph;
    if (a === b) {
      deleteText(a, start.offset, end.offset);
      edit.changed.add(a);
      this.collapse(start);
      return;
    }
    deleteText(a, start.offset, paragraphLength(a));
    deleteText(b, 0, end.offset);
    edit.changed.add(a);
    edit.changed.add(b);
    const container = findContainer(this.doc.body, a);
    if (container && container === findContainer(this.doc.body, b)) {
      // Blocks in between go; the end paragraph's rest joins the start paragraph.
      const i = container.indexOf(a);
      const j = container.indexOf(b);
      const removed = container.splice(i + 1, j - i - 1);
      if (removed.some((block) => block.kind === 'paragraph' && block.properties.section)) edit.structural = true;
      this.merge(a, b, edit);
    } else {
      // Across containers (into or out of a table): empty the paragraphs in between.
      const list = this.paragraphs();
      for (let k = this.indexOf(a) + 1; k < this.indexOf(b); k++) {
        deleteText(list[k], 0, paragraphLength(list[k]));
        edit.changed.add(list[k]);
      }
    }
    this.collapse(start);
  }

  private deleteBackward(unit: 'character' | 'word', edit: EditSet): void {
    const pos = this.selection.focus;
    const p = pos.paragraph;
    let from: number | undefined;
    if (unit === 'word') {
      const word = this.wordLeft(pos);
      from = word.paragraph === p ? word.offset : undefined;
    } else from = this.charBefore(pos)?.[0];
    if (from === undefined || from === pos.offset) {
      // At the start: a list item loses its numbering first, then paragraphs merge.
      if (p.properties.numbering) {
        delete p.properties.numbering;
        edit.changed.add(p);
        return;
      }
      const list = this.paragraphs();
      const previous = list[this.indexOf(p) - 1];
      if (!previous) return;
      const at = { paragraph: previous, offset: paragraphLength(previous) };
      if (this.merge(previous, p, edit)) this.collapse(at);
      return;
    }
    deleteText(p, from, pos.offset);
    edit.changed.add(p);
    this.collapse({ paragraph: p, offset: from });
  }

  private deleteForward(unit: 'character' | 'word', edit: EditSet): void {
    const pos = this.selection.focus;
    const p = pos.paragraph;
    const to = unit === 'word' ? this.wordRight(pos).offset : this.charAfter(pos)?.[1];
    if (to === undefined || to === pos.offset || (unit === 'word' && this.wordRight(pos).paragraph !== p)) {
      const next = this.paragraphs()[this.indexOf(p) + 1];
      if (next) this.merge(p, next, edit);
      return;
    }
    deleteText(p, pos.offset, to);
    edit.changed.add(p);
  }

  // --- Moving ----------------------------------------------------------------------------

  private move(to: MoveTarget, extend: boolean): void {
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
  private paragraphEdge(pos: Position, dir: -1 | 1): Position | null {
    const p = this.paragraphs()[this.indexOf(pos.paragraph) + dir];
    if (!p) return null;
    return { paragraph: p, offset: dir < 0 ? paragraphLength(p) : 0 };
  }

  private spans(p: Paragraph): SourceSpan[] | null {
    return this.session.linesOf(p, this.hint)[0]?.line.spans ?? null;
  }

  /** One visible character left or right within the paragraph, or null at its edge. */
  private step(pos: Position, dir: -1 | 1): Position | null {
    const range = dir < 0 ? this.charBefore(pos) : this.charAfter(pos);
    if (!range) return null;
    return { paragraph: pos.paragraph, offset: dir < 0 ? range[0] : range[1] };
  }

  /** Model range of the visible character before a position (null at the start). */
  private charBefore(pos: Position): [number, number] | null {
    const spans = this.spans(pos.paragraph);
    const text = paragraphText(pos.paragraph);
    if (!spans) {
      if (pos.offset <= 0) return null;
      const from = pos.offset >= 2 && isLow(text.charCodeAt(pos.offset - 1)) && isHigh(text.charCodeAt(pos.offset - 2)) ? pos.offset - 2 : pos.offset - 1;
      return [from, pos.offset];
    }
    const v = toVisible(spans, pos.offset);
    if (v <= 0) return null;
    const range = charRange(spans, v - 1);
    if (range[1] - range[0] === 1 && range[0] > 0 && isLow(text.charCodeAt(range[0])) && isHigh(text.charCodeAt(range[0] - 1))) range[0]--;
    return range;
  }

  /** Model range of the visible character after a position (null at the end). */
  private charAfter(pos: Position): [number, number] | null {
    const spans = this.spans(pos.paragraph);
    const text = paragraphText(pos.paragraph);
    if (!spans) {
      if (pos.offset >= text.length) return null;
      const to = isHigh(text.charCodeAt(pos.offset)) && isLow(text.charCodeAt(pos.offset + 1)) ? pos.offset + 2 : pos.offset + 1;
      return [pos.offset, to];
    }
    const v = toVisible(spans, pos.offset);
    if (v >= visibleLength(spans)) return null;
    const range = charRange(spans, v);
    if (range[1] - range[0] === 1 && isHigh(text.charCodeAt(range[0])) && isLow(text.charCodeAt(range[1]))) range[1]++;
    return range;
  }

  /** Start of this or the previous word (across a paragraph start). */
  private wordLeft(pos: Position): Position {
    const text = paragraphText(pos.paragraph);
    let i = pos.offset;
    if (i === 0) return this.paragraphEdge(pos, -1) ?? pos;
    while (i > 0 && SPACE.test(text[i - 1])) i--;
    if (i > 0 && WORD.test(text[i - 1])) while (i > 0 && WORD.test(text[i - 1])) i--;
    else if (i > 0) i--;
    return { paragraph: pos.paragraph, offset: i };
  }

  /** Start of the next word (across a paragraph end). */
  private wordRight(pos: Position): Position {
    const text = paragraphText(pos.paragraph);
    let i = pos.offset;
    if (i >= text.length) return this.paragraphEdge(pos, 1) ?? pos;
    if (WORD.test(text[i])) while (i < text.length && WORD.test(text[i])) i++;
    else if (!SPACE.test(text[i])) i++;
    while (i < text.length && SPACE.test(text[i])) i++;
    return { paragraph: pos.paragraph, offset: i };
  }

  /** The word (or run of spaces, or single character) around a position. */
  private wordAt(pos: Position): [Position, Position] {
    const text = paragraphText(pos.paragraph);
    let a = pos.offset;
    let b = pos.offset;
    const kind = (ch: string | undefined) => (ch === undefined ? 0 : WORD.test(ch) ? 1 : SPACE.test(ch) ? 2 : 3);
    const k = kind(text[a]) || kind(text[a - 1]);
    if (k === 1 || k === 2) {
      while (a > 0 && kind(text[a - 1]) === k) a--;
      while (b < text.length && kind(text[b]) === k) b++;
    } else if (b < text.length) b++;
    return [
      { paragraph: pos.paragraph, offset: a },
      { paragraph: pos.paragraph, offset: b },
    ];
  }

  // --- Lines and geometry ----------------------------------------------------------------

  /** The line a position is on (at a wrap point, the start of the next line). */
  private caretLine(pos: Position): { page: PageLayout; line: LineRecord; v: number } | null {
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
  private vertical(pos: Position, dir: -1 | 1): Position | null {
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
      if (candidates.length === 0) continue;
      // Stay in the same column (table cells) when a line there qualifies.
      const inColumn = candidates.filter((l) => goal >= l.column - 1 && goal <= l.column + Math.max(l.width + (l.x - l.column), 0) + 1);
      const pool = inColumn.length ? inColumn : candidates;
      const best = pool.reduce((a, b) => (dir < 0 ? (b.y + b.height > a.y + a.height ? b : a) : b.y < a.y ? b : a));
      return this.positionInLine(best, goal);
    }
    return dir < 0 ? { paragraph: this.paragraphs()[0], offset: 0 } : null;
  }

  private positionInLine(line: LineRecord, x: number): Position {
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
    let best = lines[0];
    let bestScore = Infinity;
    for (const l of lines) {
      const score = vertical(l) * 1000 + horizontal(l);
      if (score < bestScore) {
        best = l;
        bestScore = score;
      }
    }
    return this.positionInLine(best, x);
  }

  private pointer(command: Extract<Command, { kind: 'pointer' }>): void {
    const hit = this.hitTest(command.page, command.x, command.y);
    if (!hit) return;
    if (command.unit === 'word') {
      const [a, b] = this.wordAt(hit);
      this.selection = { anchor: a, focus: b };
    } else if (command.unit === 'paragraph') {
      this.selection = { anchor: { paragraph: hit.paragraph, offset: 0 }, focus: { paragraph: hit.paragraph, offset: paragraphLength(hit.paragraph) } };
    } else if (command.extend) {
      this.selection = { anchor: this.selection.anchor, focus: hit };
    } else {
      this.collapse(hit);
    }
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

  /** Caret or highlight for the current selection, on the session's display pages. */
  geometry(): SelectionGeometry {
    const focus = this.caret(this.selection.focus);
    if (this.collapsed) return { caret: focus, rects: [], focus };
    return { caret: null, rects: this.selectionRects(), focus };
  }

  private selectionRects(): Rect[] {
    const [start, end] = this.ordered();
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

/** Model changes made by one command. */
class EditSet {
  readonly changed = new Set<Paragraph>();
  /** Sections changed: lay out everything again. */
  structural = false;
  /** Paragraphs were added or removed. */
  structureChanged = false;
}

/** Model range of the visible character at a visible offset. */
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
