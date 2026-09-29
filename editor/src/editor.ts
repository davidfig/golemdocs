// Editing: a selection in model positions, commands that edit the model (and tell layout
// what changed), and caret/selection geometry from the laid-out lines.
//
// Everything is addressed in model offsets (see @word/docx edit/text.ts), not in laid-out
// text, so commands can be replayed on another client or a server and positions stay put
// when layout changes. Visible offsets only appear when talking to layout (stepping over
// hidden text, caret x positions).

import {
  commentEnd,
  commentMarkerOffsets,
  commentRanges,
  commentReference,
  commentStart,
  newParagraphProperties,
  paragraphLength,
  paragraphsIn,
  paragraphText,
  plainText,
  runPropertiesAt,
  type Paragraph,
  type ParagraphProperties,
  type WordDocument,
} from '@word/docx';
import { END, Replica, type Applied, type Operation, type Pos, type RemoteChange, type Selection as OpSelection, type ServerMessage } from '@word/ops';
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
  | { kind: 'selectAll' }
  /** Comments the selection (or, with none, the word at the caret). */
  | { kind: 'addComment'; text: string; author: string; date?: string }
  /** Changes a comment's text. */
  | { kind: 'editComment'; id: string; text: string }
  /** Removes a comment and its markers from the text. */
  | { kind: 'deleteComment'; id: string }
  /** Selects the text a comment is on. */
  | { kind: 'selectComment'; id: string };

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

/** A comment's text and where it is shown. */
export interface CommentGeometry {
  id: string;
  author: string;
  date?: string;
  text: string;
  /** Highlight over its range (empty when that isn't laid out yet). */
  rects: Rect[];
}

/** What a command did to the document (to lay out again). */
export interface CommandResult {
  edited: boolean;
  changed: Set<Paragraph>;
  structural: boolean;
}

const NO_CHANGE: CommandResult = { edited: false, changed: new Set(), structural: false };

export class Editor {
  selection: Selection;
  /** x the caret tries to keep while moving up and down. */
  private goalX: number | null = null;
  private order: Map<Paragraph, number> | null = null;
  private list: Paragraph[] = [];
  /** Display page index near the caret, to find lines quickly. */
  private hint = 0;
  private commands = 0;

  constructor(
    /** The document, edited through operations (undo, collaboration). */
    readonly replica: Replica,
    readonly session: LayoutSession,
  ) {
    const first = this.paragraphs()[0];
    this.selection = { anchor: { paragraph: first, offset: 0 }, focus: { paragraph: first, offset: 0 } };
  }

  get doc(): WordDocument {
    return this.replica.doc;
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

  // --- Positions as operations address them ----------------------------------------------

  private pos(position: Position): Pos {
    // A paragraph that's gone (removed by someone else, say) can't be addressed: its start.
    if (!this.replica.engine.index.has(position.paragraph.attrs['w14:paraId'] ?? '') || this.replica.paragraph(position.paragraph.attrs['w14:paraId']) !== position.paragraph) {
      return { paragraph: this.replica.id(this.paragraphs()[0]), offset: 0 };
    }
    return { paragraph: this.replica.id(position.paragraph), offset: position.offset };
  }

  private position(pos: Pos): Position | null {
    const paragraph = this.replica.paragraph(pos.paragraph);
    return paragraph ? { paragraph, offset: Math.min(pos.offset, paragraphLength(paragraph)) } : null;
  }

  /** The selection by paragraph ids (for undo history, collaboration). */
  get selectionIds(): OpSelection {
    return { anchor: this.pos(this.selection.anchor), focus: this.pos(this.selection.focus) };
  }

  /** Caret geometry at a position given by ids (someone else's caret), if that's laid out. */
  caretAt(pos: Pos): Caret | null {
    const position = this.position(pos);
    if (!position) return null;
    const hint = this.hint;
    const caret = this.caret(position);
    this.hint = hint;
    return caret;
  }

  /** Sets the selection by ids; positions whose paragraph is gone fall back to the document start. */
  setSelectionIds(selection: OpSelection): void {
    const first = { paragraph: this.paragraphs()[0], offset: 0 };
    const anchor = this.position(selection.anchor) ?? first;
    const focus = this.position(selection.focus) ?? anchor;
    this.selection = { anchor, focus };
  }

  // --- Commands --------------------------------------------------------------------------

  /** Applies a command. Edits invalidate the session; run it afterwards to update layout. */
  apply(command: Command): CommandResult {
    if (command.kind !== 'move' || (command.to !== 'up' && command.to !== 'down')) this.goalX = null;
    switch (command.kind) {
      case 'insertText':
      case 'insertParagraph':
      case 'insertLineBreak': {
        // Typing over a selection: delete it first (as its own step, undone together with
        // the insertion), then insert at the document as it now is.
        const group = this.collapsed ? undefined : `replace:${this.commands++}`;
        const removed = this.collapsed ? NO_CHANGE : this.edit(this.deleteSelection(), group);
        const at = this.selection.focus;
        let ops: Operation[];
        let after: Pos;
        if (command.kind === 'insertText') [ops, after] = this.insertOps(at, command.text);
        else if (command.kind === 'insertParagraph') [ops, after] = this.splitOps(at);
        else {
          ops = [{ type: 'insertItem', paragraph: this.replica.id(at.paragraph), offset: at.offset, item: { kind: 'break' } }];
          after = { paragraph: this.replica.id(at.paragraph), offset: at.offset + 1 };
        }
        const typing = command.kind === 'insertText' && !command.text.includes('\n') ? 'typing' : undefined;
        return combine(removed, this.edit([ops, after], group ?? typing));
      }
      case 'delete':
        if (!this.collapsed) return this.edit(this.deleteSelection());
        return this.edit(command.direction === 'backward' ? this.deleteBackward(command.unit ?? 'character') : this.deleteForward(command.unit ?? 'character'), 'deleting');
      case 'move':
        this.move(command.to, command.extend ?? false);
        return NO_CHANGE;
      case 'pointer':
        this.pointer(command);
        return NO_CHANGE;
      case 'selectAll': {
        const list = this.paragraphs();
        const last = list[list.length - 1];
        this.selection = { anchor: { paragraph: list[0], offset: 0 }, focus: { paragraph: last, offset: paragraphLength(last) } };
        return NO_CHANGE;
      }
      case 'addComment':
        return this.edit(this.addCommentOps(command));
      case 'editComment': {
        const comment = this.doc.comments.find((c) => c.id === command.id);
        if (!comment) return NO_CHANGE;
        const ops: Operation[] = [{ type: 'setComment', id: command.id, comment: { ...comment, paragraphs: command.text.split(/\r\n?|\n/) } }];
        return this.edit([ops, this.selectionIds.focus]);
      }
      case 'deleteComment':
        return this.edit(this.deleteCommentOps(command.id));
      case 'selectComment': {
        const range = commentRanges(this.paragraphs()).get(command.id);
        if (range) this.selection = { anchor: { ...range.start }, focus: { ...range.end } };
        return NO_CHANGE;
      }
    }
  }

  // --- Comments --------------------------------------------------------------------------

  private addCommentOps(command: Extract<Command, { kind: 'addComment' }>): [Operation[], Pos] {
    let [start, end] = this.ordered();
    if (this.collapsed) [start, end] = this.wordAt(start);
    // Ids are decimal (w:id); random so that two people commenting at once don't collide.
    const taken = new Set([...this.doc.comments.map((c) => c.id), ...commentRanges(this.paragraphs()).keys()]);
    let id: string;
    do id = String(Math.floor(Math.random() * 0x7fffffff));
    while (taken.has(id));
    const startPos = this.pos(start);
    const endPos = this.pos(end);
    const ops: Operation[] = [
      { type: 'setComment', id, comment: { id, author: command.author, date: command.date ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z'), paragraphs: command.text.split(/\r\n?|\n/) } },
      // The end first, so the start's offset still holds when both are in one paragraph.
      { type: 'insertContent', paragraph: endPos.paragraph, offset: endPos.offset, content: [commentEnd(id), commentReference(id)] },
      { type: 'insertContent', paragraph: startPos.paragraph, offset: startPos.offset, content: [commentStart(id)] },
    ];
    const shift = start.paragraph === end.paragraph ? 1 : 0;
    return [ops, { paragraph: endPos.paragraph, offset: endPos.offset + shift + 2 }];
  }

  private deleteCommentOps(id: string): [Operation[], Pos] | null {
    const ops: Operation[] = [];
    for (const p of this.paragraphs()) {
      for (const offset of commentMarkerOffsets(p, id)) ops.push({ type: 'delete', paragraph: this.replica.id(p), from: offset, to: offset + 1 });
    }
    if (this.doc.comments.some((c) => c.id === id)) ops.push({ type: 'setComment', id, comment: null });
    if (!ops.length) return null;
    // Keep the caret where it is, moved back over any markers before it.
    const focus = this.selection.focus;
    const before = commentMarkerOffsets(focus.paragraph, id).filter((o) => o < focus.offset).length;
    return [ops, { paragraph: this.replica.id(focus.paragraph), offset: focus.offset - before }];
  }

  /** Every comment, with the highlight over its range. */
  comments(): CommentGeometry[] {
    if (!this.doc.comments.length) return [];
    const ranges = commentRanges(this.paragraphs());
    return this.doc.comments.map((c) => {
      const range = ranges.get(c.id);
      return {
        id: c.id,
        author: c.author,
        ...(c.date && { date: c.date }),
        text: c.paragraphs.join('\n'),
        rects: range ? this.rangeRects(range.start, range.end) : [],
      };
    });
  }

  /** Applies planned operations as one local edit and moves the selection. */
  private edit(plan: [Operation[], Pos] | null, group?: string): CommandResult {
    if (!plan || plan[0].length === 0) return NO_CHANGE;
    const [ops, after] = plan;
    const change = this.replica.edit(ops, { before: this.selectionIds, after: { anchor: after, focus: after }, group });
    return this.changed(change.applied, { anchor: after, focus: after });
  }

  /** After the document changed: lay out again, put the selection where it belongs. */
  private changed(applied: Applied, selection: OpSelection | null): CommandResult {
    this.structureChanged();
    this.session.invalidate(applied.changed, { structural: applied.structural });
    if (selection) this.setSelectionIds(selection);
    else this.setSelectionIds(this.selectionIds);
    return { edited: true, changed: applied.changed, structural: applied.structural };
  }

  undo(): CommandResult {
    const current = this.selectionIds;
    const change = this.replica.undo();
    return change ? this.changed(change.applied, change.selection ?? current) : NO_CHANGE;
  }

  redo(): CommandResult {
    const current = this.selectionIds;
    const change = this.replica.redo();
    return change ? this.changed(change.applied, change.selection ?? current) : NO_CHANGE;
  }

  /**
   * A message from the collaboration server: applies others' edits (rebasing ours), lays out
   * again and keeps the selection where it was in the text. Returns the change, if any.
   */
  receive(message: ServerMessage): { result: CommandResult; change: RemoteChange | null } {
    // By id, before paragraphs it's in can go away.
    const before = this.selectionIds;
    const change = this.replica.receive(message);
    if (!change) return { result: NO_CHANGE, change: null };
    const selection = Replica.mapSelection(before, change.mapping);
    this.structureChanged();
    this.session.invalidate(change.changed, { structural: change.structural });
    this.setSelectionIds(selection);
    return { result: { edited: true, changed: change.changed, structural: change.structural }, change };
  }

  /** Text (with tabs and line breaks as new paragraphs) at a position. */
  private insertOps(at: Position, text: string): [Operation[], Pos] {
    const ops: Operation[] = [];
    let pos = this.pos(at);
    const runProperties = runPropertiesAt(at.paragraph, at.offset);
    text.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
      if (i > 0) {
        const id = this.replica.newId();
        const properties = newParagraphProperties(at.paragraph.properties, false, this.doc.styles, runProperties);
        ops.push({ type: 'split', paragraph: pos.paragraph, offset: pos.offset, id, properties });
        pos = { paragraph: id, offset: 0 };
      }
      line.split('\t').forEach((part, j) => {
        if (j > 0) {
          ops.push({ type: 'insertItem', paragraph: pos.paragraph, offset: pos.offset, item: { kind: 'tab' } });
          pos = { paragraph: pos.paragraph, offset: pos.offset + 1 };
        }
        if (part) {
          ops.push({ type: 'insertText', paragraph: pos.paragraph, offset: pos.offset, text: part });
          pos = { paragraph: pos.paragraph, offset: pos.offset + part.length };
        }
      });
    });
    return [ops, pos];
  }

  /** Enter: the new paragraph continues the formatting at the caret (and takes the next style at an end). */
  private splitOps(at: Position): [Operation[], Pos] {
    const p = at.paragraph;
    const id = this.replica.newId();
    const atEnd = at.offset >= paragraphLength(p);
    const properties = newParagraphProperties(p.properties, atEnd, this.doc.styles, runPropertiesAt(p, at.offset));
    const ops: Operation[] = [{ type: 'split', paragraph: this.replica.id(p), offset: at.offset, id, properties }];
    // A section break belongs to the paragraph mark, which is now the new paragraph's.
    if (p.properties.section) ops.push(this.setProperties(p, { section: undefined }));
    return [ops, { paragraph: id, offset: 0 }];
  }

  private setProperties(p: Paragraph, changes: Partial<ParagraphProperties>): Operation {
    const properties: ParagraphProperties = { ...structuredClone(p.properties), ...structuredClone(changes) };
    for (const key of Object.keys(changes) as (keyof ParagraphProperties)[]) if (changes[key] === undefined) delete properties[key];
    return { type: 'setParagraphProperties', paragraph: this.replica.id(p), properties };
  }

  /** Deletes the selection; the caret goes to its start. */
  private deleteSelection(): [Operation[], Pos] | null {
    if (this.collapsed) return null;
    const [start, end] = this.ordered();
    const a = start.paragraph;
    const b = end.paragraph;
    const ida = this.replica.id(a);
    const ops: Operation[] = [];
    if (a === b) {
      ops.push({ type: 'delete', paragraph: ida, from: start.offset, to: end.offset });
      // Emptying a paragraph: its mark keeps the deleted text's formatting for what's typed next.
      if (start.offset === 0 && end.offset >= paragraphLength(a)) {
        const carried = runPropertiesAt(a, 0);
        if (carried && JSON.stringify(carried) !== JSON.stringify(a.properties.runProperties ?? {})) ops.push(this.setProperties(a, { runProperties: carried }));
      }
      return [ops, this.pos(start)];
    }
    ops.push({ type: 'delete', paragraph: ida, from: start.offset, to: END });
    ops.push({ type: 'delete', paragraph: this.replica.id(b), from: 0, to: end.offset });
    const index = this.replica.engine.index;
    const container = index.container(a);
    if (container && container === index.container(b)) {
      // Blocks in between go; the end paragraph's rest joins the start paragraph.
      if (container.indexOf(b) > container.indexOf(a) + 1) ops.push({ type: 'removeBetween', after: ida, before: this.replica.id(b) });
      if (b.properties.section) ops.push(this.setProperties(a, { section: b.properties.section }));
      ops.push({ type: 'merge', paragraph: ida, next: this.replica.id(b) });
    } else {
      // Across containers (into or out of a table): empty the paragraphs in between.
      const list = this.paragraphs();
      for (let k = this.indexOf(a) + 1; k < this.indexOf(b); k++) ops.push({ type: 'delete', paragraph: this.replica.id(list[k]), from: 0, to: END });
    }
    return [ops, this.pos(start)];
  }

  /** Merges `second` into the paragraph before it (keeping a section break it ends). */
  private mergeOps(first: Paragraph, second: Paragraph): Operation[] {
    const container = this.replica.engine.index.container(second);
    if (!container || container[container.indexOf(second) - 1] !== first) return [];
    const ops: Operation[] = [];
    if (second.properties.section) ops.push(this.setProperties(first, { section: second.properties.section }));
    ops.push({ type: 'merge', paragraph: this.replica.id(first), next: this.replica.id(second) });
    return ops;
  }

  private deleteBackward(unit: 'character' | 'word'): [Operation[], Pos] | null {
    const pos = this.selection.focus;
    const p = pos.paragraph;
    let from: number | undefined;
    if (unit === 'word') {
      const word = this.wordLeft(pos);
      from = word.paragraph === p ? word.offset : undefined;
    } else from = this.charBefore(pos)?.[0];
    if (from === undefined || from === pos.offset) {
      // At the start: a list item loses its numbering first, then paragraphs merge.
      if (p.properties.numbering) return [[this.setProperties(p, { numbering: undefined })], this.pos(pos)];
      const previous = this.paragraphs()[this.indexOf(p) - 1];
      if (!previous) return null;
      const at = { paragraph: this.replica.id(previous), offset: paragraphLength(previous) };
      return [this.mergeOps(previous, p), at];
    }
    return [[{ type: 'delete', paragraph: this.replica.id(p), from, to: pos.offset }], { paragraph: this.replica.id(p), offset: from }];
  }

  private deleteForward(unit: 'character' | 'word'): [Operation[], Pos] | null {
    const pos = this.selection.focus;
    const p = pos.paragraph;
    const to = unit === 'word' ? this.wordRight(pos).offset : this.charAfter(pos)?.[1];
    if (to === undefined || to === pos.offset || (unit === 'word' && this.wordRight(pos).paragraph !== p)) {
      const next = this.paragraphs()[this.indexOf(p) + 1];
      return next ? [this.mergeOps(p, next), this.pos(pos)] : null;
    }
    return [[{ type: 'delete', paragraph: this.replica.id(p), from: pos.offset, to }], this.pos(pos)];
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
    return this.rangeRects(start, end);
  }

  /** Highlight rectangles over the text from `start` to `end` (in document order). */
  private rangeRects(start: Position, end: Position): Rect[] {
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

function combine(a: CommandResult, b: CommandResult): CommandResult {
  if (!a.edited) return b;
  if (!b.edited) return a;
  return { edited: true, changed: new Set([...a.changed, ...b.changed]), structural: a.structural || b.structural };
}

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
