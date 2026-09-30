// Editing: a selection in model positions, commands that edit the model (and tell layout
// what changed), and caret/selection geometry from the laid-out lines.
//
// Everything is addressed in model offsets (see @word/docx edit/text.ts), not in laid-out
// text, so commands can be replayed on another client or a server and positions stay put
// when layout changes. Visible offsets only appear when talking to layout (stepping over
// hidden text, caret x positions).

import {
  type Comment,
  commentEnd,
  commentMarkerOffsets,
  commentRanges,
  commentReference,
  commentStart,
  inlineLength,
  inlinesLength,
  mathAt,
  newParagraphProperties,
  paragraphLength,
  paragraphsIn,
  paragraphText,
  plainText,
  readMathInline,
  runPropertiesAt,
  runsIn,
  splitInlines,
  OBJECT_CHAR,
  type Block,
  type MathEquation,
  type DocumentProperties,
  type Hyperlink,
  type Inline,
  type Paragraph,
  type ParagraphProperties,
  type SectionProperties,
  type Table,
  type TableCell,
  type TableCellProperties,
  type TableRow,
  type RunProperties,
  type WordDocument,
} from '@word/docx';
import { blockKey, END, Replica, type Applied, type Operation, type Pos, type RemoteChange, type RunFormat, type Selection as OpSelection, type ServerMessage } from '@word/ops';
import { mergeCells, splitCell } from './tableModel.ts';
import { cjkWords, graphemeAt, isWordBoundary, segmentAt } from './segment.ts';
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

/** Paragraph property changes: a value to set, or undefined to remove it. */
export type ParagraphFormat = { [K in keyof ParagraphProperties]?: ParagraphProperties[K] | undefined };

export type Command =
  | { kind: 'insertText'; text: string }
  | { kind: 'insertParagraph' }
  /** Inline content as it is (a picture, say) at the caret, replacing what is selected; the caret goes after it. */
  | { kind: 'insertContent'; content: Inline[] }
  /** A line break, or a page or column break. */
  | { kind: 'insertLineBreak'; type?: 'page' | 'column' }
  /**
   * Formats the selected text: the same change everywhere, or one worked out per run from its
   * direct formatting (growing each run's size, say). A caret inside a word formats the word;
   * anywhere else the change applies to what's typed next there. `define` are operations to
   * apply first in the same step (a style the formatting uses, say).
   */
  | { kind: 'formatText'; format: RunFormat | ((run: RunProperties, paragraph: Paragraph) => RunFormat | null); define?: Operation[] }
  /** Changes the properties of each paragraph the selection touches (null: leave it as is). */
  | { kind: 'formatParagraphs'; change: (paragraph: Paragraph, index: number) => ParagraphFormat | null; define?: Operation[] }
  /** Changes the case of the selected text (or the word at the caret), keeping its formatting. */
  | { kind: 'changeCase'; change: (text: string) => string }
  | { kind: 'delete'; direction: 'backward' | 'forward'; unit?: 'character' | 'word' }
  | { kind: 'move'; to: MoveTarget; extend?: boolean }
  /** A click or drag at page-relative points; `unit` selects a word or paragraph (double/triple click). */
  | { kind: 'pointer'; page: PageLayout; x: number; y: number; extend?: boolean; unit?: 'character' | 'word' | 'paragraph' }
  | { kind: 'selectAll' }
  /** Comments the selection (or, with none, the word at the caret). */
  | { kind: 'addComment'; text: string; author: string; date?: string }
  /** Changes a comment's text. */
  | { kind: 'editComment'; id: string; text: string }
  /** Adds a reply to a comment's thread (replying to a reply replies to the thread). */
  | { kind: 'replyComment'; id: string; text: string; author: string; date?: string }
  /** Marks a comment's thread resolved, or open again. */
  | { kind: 'resolveComment'; id: string; resolved: boolean }
  /** Removes a comment, its replies and their markers from the text. */
  | { kind: 'deleteComment'; id: string }
  /** Selects the text a comment is on. */
  | { kind: 'selectComment'; id: string }
  /** Selects the next (or previous) match of `text` after the selection, wrapping around the document. */
  | { kind: 'find'; text: string; matchCase?: boolean; backward?: boolean; wholeWord?: boolean }
  /** Replaces every match of `text` in the document. */
  | { kind: 'replaceAll'; text: string; with: string; matchCase?: boolean; wholeWord?: boolean }
  /** Selects positions [from, to) of the paragraph at `paragraph` (its index among the document's paragraphs). */
  | { kind: 'select'; paragraph: number; from: number; to: number }
  /**
   * Makes the selected text a link to `url` (keeping its formatting when `text` is what it says),
   * or inserts a link showing `text` at the caret. Inside a link, changes that link instead.
   */
  | { kind: 'setLink'; url: string; text: string }
  /** Takes the link at the selection off its text. */
  | { kind: 'removeLink' }
  /**
   * Inserts a table of empty cells after the selection's paragraph (splitting it at the caret, if the
   * caret is in the middle of text), and puts the caret in its first cell. `define` are operations
   * to apply first (the table style). Only in the body: not inside a table.
   */
  | { kind: 'insertTable'; rows: number; columns: number; define?: Operation[] }
  /**
   * Sets the columns of text (1 to 12, `space` twips apart, a line between them if `sep`) of the
   * whole document, of the section the caret is in, or from the caret on (a continuous section
   * break is put in at the caret).
   */
  | { kind: 'setColumns'; count: number; space: number; sep: boolean; scope: 'document' | 'section' | 'forward' }
  /**
   * Sets the page size (twips; `landscape` says which way up) and margins, header and footer distances
   * of the whole document, the section the caret is in, or from the caret on (which starts a new page).
   */
  | { kind: 'setPage'; width: number; height: number; landscape: boolean; top: number; bottom: number; left: number; right: number; gutter: number; header: number; footer: number; scope: 'document' | 'section' | 'forward' }
  /**
   * Puts paragraphs and tables in at the caret (over the selection): a single paragraph's text goes
   * in the paragraph the caret is in; more than one splits it, the first one's text going on the end
   * of the first half and the last one's in front of the second. `define` (styles, list definitions)
   * is applied first. Paragraph ids are made here.
   */
  | { kind: 'pasteContent'; blocks: Block[]; define?: Operation[] }
  /** Sets the document's properties (title, author, keywords... of File ▸ Properties). */
  | { kind: 'setProperties'; properties: DocumentProperties }
  /** Rows, columns or the whole table the selection is in: insert, delete or select. */
  | { kind: 'tableEdit'; edit: TableEdit }
  /**
   * The Tab key: in a table, on to the next cell (backward: the one before), adding a row after the
   * last cell; anywhere else a tab character (backward does nothing).
   */
  | { kind: 'tab'; backward: boolean }
  /** Splits the cell the selection is in into `columns` by `rows` cells (merged cells split back along their merges first). */
  | { kind: 'splitCells'; columns: number; rows: number }

/** Changes to the table the selection is in (Word's Table menu). */
export type TableEdit = 'insertRowAbove' | 'insertRowBelow' | 'insertColumnLeft' | 'insertColumnRight' | 'deleteRows' | 'deleteColumns' | 'deleteTable' | 'selectTable' | 'mergeCells';

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
  initials?: string;
  date?: string;
  /** The comment this replies to. */
  parentId?: string;
  resolved?: boolean;
  text: string;
  /** Highlight over its range (empty when that isn't laid out yet). */
  rects: Rect[];
}

/** What a command did to the document (to lay out again). */
export interface CommandResult {
  edited: boolean;
  changed: Set<Paragraph>;
  structural: boolean;
  /** Styles or list definitions changed. */
  styles?: boolean;
  /** Find: whether a match was found. Replace All: how many were replaced. */
  found?: boolean;
  replaced?: number;
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
  /** Formatting chosen at a caret, for the text typed next there. */
  pending: RunFormat | null = null;

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
    const pending = this.pending;
    if (command.kind !== 'formatText') this.pending = null;
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
        if (command.kind === 'insertText') {
          [ops, after] = this.insertOps(at, command.text);
          if (pending) {
            for (const op of [...ops]) {
              if (op.type === 'insertText') ops.push({ type: 'formatText', paragraph: op.paragraph, from: op.offset, to: op.offset + op.text.length, format: pending });
            }
          }
        } else if (command.kind === 'insertParagraph') [ops, after] = this.splitOps(at);
        else {
          const item = command.type ? ({ kind: 'break', type: command.type } as const) : ({ kind: 'break' } as const);
          ops = [{ type: 'insertItem', paragraph: this.replica.id(at.paragraph), offset: at.offset, item }];
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
      case 'formatText':
        return this.formatText(command);
      case 'formatParagraphs': {
        const ops = [...(command.define ?? [])];
        this.selectedParagraphs().forEach((p, i) => {
          const change = command.change(p, i);
          if (change && Object.keys(change).length) ops.push(this.setProperties(p, change));
        });
        return this.editInPlace(ops);
      }
      case 'changeCase':
        return this.editInPlace(this.changeCaseOps(command.change));
      case 'addComment':
        return this.edit(this.addCommentOps(command));
      case 'editComment': {
        const comment = this.doc.comments.find((c) => c.id === command.id);
        if (!comment) return NO_CHANGE;
        const ops: Operation[] = [{ type: 'setComment', id: command.id, comment: { ...comment, paragraphs: command.text.split(/\r\n?|\n/) } }];
        return this.edit([ops, this.selectionIds.focus]);
      }
      case 'replyComment':
        return this.edit(this.replyCommentOps(command));
      case 'resolveComment': {
        const root = this.threadRoot(command.id);
        if (!root || !!root.resolved === command.resolved) return NO_CHANGE;
        const { resolved: _old, ...rest } = root;
        const ops: Operation[] = [{ type: 'setComment', id: root.id, comment: command.resolved ? { ...rest, resolved: true } : rest }];
        return this.edit([ops, this.selectionIds.focus]);
      }
      case 'deleteComment':
        return this.edit(this.deleteCommentOps(command.id));
      case 'selectComment': {
        const range = commentRanges(this.paragraphs()).get(command.id);
        if (range) this.selection = { anchor: { ...range.start }, focus: { ...range.end } };
        return NO_CHANGE;
      }
      case 'find':
        return { ...NO_CHANGE, found: this.find(command.text, command.matchCase ?? false, command.backward ?? false, command.wholeWord ?? false) };
      case 'replaceAll':
        return this.replaceAll(command.text, command.with, command.matchCase ?? false, command.wholeWord ?? false);
      case 'select': {
        const paragraph = this.paragraphs()[command.paragraph];
        if (paragraph) {
          const length = paragraphLength(paragraph);
          this.selection = { anchor: { paragraph, offset: Math.min(command.from, length) }, focus: { paragraph, offset: Math.min(command.to, length) } };
        }
        return NO_CHANGE;
      }
      case 'insertContent': {
        const group = this.collapsed ? undefined : `replace:${this.commands++}`;
        const removed = this.collapsed ? NO_CHANGE : this.edit(this.deleteSelection(), group);
        const at = this.selection.focus;
        const id = this.replica.id(at.paragraph);
        const ops: Operation[] = [{ type: 'insertContent', paragraph: id, offset: at.offset, content: command.content }];
        return combine(removed, this.edit([ops, { paragraph: id, offset: at.offset + inlinesLength(command.content) }], group));
      }
      case 'setLink':
        return this.edit(this.setLinkOps(command.url, command.text));
      case 'removeLink':
        return this.edit(this.removeLinkOps());
      case 'insertTable':
        return this.edit(this.insertTableOps(command.rows, command.columns, command.define ?? []));
      case 'tableEdit':
        return this.tableEdit(command.edit);
      case 'setColumns':
        return this.edit(this.setColumnsOps(command));
      case 'setPage':
        return this.edit(this.setPageOps(command));
      case 'pasteContent':
        return this.pasteContent(command.blocks, command.define ?? []);
      case 'setProperties':
        return this.edit([[{ type: 'setDocumentProperties', properties: command.properties }], this.selectionIds.focus]);
      case 'tab':
        return this.tab(command.backward);
      case 'splitCells':
        return this.splitCells(command.columns, command.rows);
    }
  }

  // --- Tables ----------------------------------------------------------------------------

  /** Twips between the margins of the document's page (Word's default 6.5in when it says nothing). */
  private textWidth(section: SectionProperties = this.doc.section): number {
    const { pageSize, margins } = section ?? {};
    const width = (pageSize?.w ?? 12240) - (margins?.left ?? 1440) - (margins?.right ?? 1440) - (margins?.gutter ?? 0);
    return width > 720 ? width : 9360;
  }

  private insertTableOps(rows: number, columns: number, define: Operation[]): [Operation[], Pos] | null {
    rows = Math.floor(rows);
    columns = Math.floor(columns);
    if (!(rows >= 1 && rows <= 500 && columns >= 1 && columns <= 63)) return null;
    const [start] = this.ordered();
    const paragraph = start.paragraph;
    const container = this.replica.engine.index.container(paragraph);
    // Tables go in the body (a table in a table cell is a step further).
    if (!container || container !== this.doc.body) return null;
    // Cell paragraphs need ids of their own, all different.
    const fresh = this.idMaker();
    const ops: Operation[] = [...define];
    const anchor = this.replica.id(paragraph);
    let needsTrailer = false;
    // At the start of a paragraph the table goes above it; the paragraph is the one after it.
    const above = start.offset === 0;
    if (above) {
      // (nothing to split, nothing to add after)
    } else if (start.offset < paragraphLength(paragraph)) {
      // In the middle of text: what follows the caret goes below the table.
      const [split] = this.splitOps(start);
      ops.push(...split);
    } else {
      // The table has to be followed by a paragraph.
      needsTrailer = container[container.indexOf(paragraph) + 1]?.kind !== 'paragraph';
    }
    const width = Math.floor(this.textWidth() / columns);
    const cellParagraph = (): Paragraph => ({ kind: 'paragraph', properties: {}, children: [], attrs: { 'w14:paraId': fresh() } });
    const table: Table = {
      kind: 'table',
      properties: { style: 'TableGrid', width: { w: '0', type: 'auto' }, look: { val: '0420', firstRow: true, noVBand: true } },
      grid: new Array<number>(columns).fill(width),
      rows: Array.from({ length: rows }, (): TableRow => ({
        kind: 'row',
        properties: {},
        cells: Array.from({ length: columns }, (): TableCell => ({ kind: 'cell', properties: { width: { w: String(width), type: 'dxa' } }, children: [cellParagraph()], attrs: {} })),
        attrs: {},
      })),
    };
    const first = paragraphsIn([table])[0].attrs['w14:paraId'];
    const blocks: Block[] = needsTrailer ? [table, cellParagraph()] : [table];
    ops.push({ type: 'insertBlocks', after: anchor, blocks, ...(above && { before: true }) });
    return [ops, { paragraph: first, offset: 0 }];
  }

  // --- Pasting ------------------------------------------------------------------------

  private pasteContent(source: Block[], define: Operation[]): CommandResult {
    const blocks = structuredClone(source);
    const fresh = this.idMaker();
    for (const p of paragraphsIn(blocks)) p.attrs = { ...p.attrs, 'w14:paraId': fresh() };
    // Over a selection, typing over it: the two are one undo step.
    const group = this.collapsed ? undefined : `replace:${this.commands++}`;
    const removed = this.collapsed ? NO_CHANGE : this.edit(this.deleteSelection(), group);
    const at = this.selection.focus;
    const p = at.paragraph;
    // A table can't go in a table cell (yet).
    const list = blocks.filter((b) => b.kind === 'paragraph' || !this.replica.engine.index.locate(p));
    if (list.length === 0) return removed;
    const id = this.replica.id(p);
    const length = paragraphLength(p);
    const ops: Operation[] = [...define];

    const only = list.length === 1 && list[0].kind === 'paragraph' ? list[0] : null;
    if (only) {
      if (only.children.length === 0) return removed;
      ops.push({ type: 'insertContent', paragraph: id, offset: at.offset, content: only.children });
      return combine(removed, this.edit([ops, { paragraph: id, offset: at.offset + inlinesLength(only.children) }], group));
    }

    const remainder = at.offset < length;
    const head = list[0].kind === 'paragraph' ? list[0] : null;
    let tail = remainder && list[list.length - 1].kind === 'paragraph' && list.length > 1 ? (list[list.length - 1] as Paragraph) : null;
    const middle = list.slice(head ? 1 : 0, tail ? list.length - 1 : list.length);
    // Ending on a table needs a paragraph after it (with text after the caret, that is the split-off rest).
    if (!remainder && middle.length && middle[middle.length - 1].kind === 'table') middle.push({ kind: 'paragraph', properties: {}, children: [], attrs: { 'w14:paraId': fresh() } });
    let splitId: string | undefined;
    if (remainder) {
      const [splitting] = this.splitOps(at);
      splitId = (splitting.find((op) => op.type === 'split') as Extract<Operation, { type: 'split' }>).id;
      ops.push(...splitting);
    } else tail = null;
    if (head) {
      // An empty paragraph takes the look of what is pasted into it (a heading, a list item).
      if (length === 0 && !remainder) ops.push(this.setProperties(p, { ...structuredClone(head.properties), section: p.properties.section }));
      if (head.children.length) ops.push({ type: 'insertContent', paragraph: id, offset: at.offset, content: head.children });
    }
    if (middle.length) ops.push({ type: 'insertBlocks', after: id, blocks: middle });
    if (tail && splitId) ops.push({ type: 'insertContent', paragraph: splitId, offset: 0, content: tail.children });

    let after: Pos = { paragraph: id, offset: at.offset + (head ? inlinesLength(head.children) : 0) };
    const lastMiddle = middle.length ? paragraphsIn([middle[middle.length - 1]]).at(-1) : undefined;
    if (splitId && (tail || middle.at(-1)?.kind === 'table')) after = { paragraph: splitId, offset: tail ? inlinesLength(tail.children) : 0 };
    else if (lastMiddle) after = { paragraph: lastMiddle.attrs['w14:paraId'], offset: paragraphLength(lastMiddle) };
    return combine(removed, this.edit([ops, after], group));
  }

  // --- Sections and columns --------------------------------------------------------------

  /** The paragraph that ends the section a paragraph is in, or null for the document's last section. */
  private sectionEnd(paragraph: Paragraph): Paragraph | null {
    const list = this.paragraphs();
    for (let i = this.indexOf(paragraph); i >= 0 && i < list.length; i++) if (list[i].properties.section) return list[i];
    return null;
  }

  /** The columns of the section the caret is in, and the width of its text area (twips), for the Columns dialog. */
  sectionColumns(): { count: number; space: number; sep: boolean; width: number } {
    const end = this.sectionEnd(this.selection.focus.paragraph);
    const section = end?.properties.section ?? this.doc.section;
    return { count: section.columns?.num ?? 1, space: section.columns?.space ?? 720, sep: !!section.columns?.sep, width: this.textWidth(section) };
  }

  private setColumnsOps(c: Extract<Command, { kind: 'setColumns' }>): [Operation[], Pos] | null {
    const count = Math.floor(c.count);
    if (!(count >= 1 && count <= 12) || !(c.space >= 0 && c.space <= 5760)) return null;
    // No columns element at all for one.
    return this.editSections(c.scope, 'continuous', (section) => {
      const next = structuredClone(section);
      if (count > 1) next.columns = { num: count, space: Math.round(c.space), equalWidth: true, ...(c.sep && { sep: true }) };
      else delete next.columns;
      return next;
    });
  }

  /** The page size and margins of the section the caret is in (twips), for the Page Setup dialog. */
  sectionPage(): { width: number; height: number; landscape: boolean; top: number; bottom: number; left: number; right: number; gutter: number; header: number; footer: number } {
    const end = this.sectionEnd(this.selection.focus.paragraph);
    const { pageSize, margins } = end?.properties.section ?? this.doc.section;
    return {
      width: pageSize?.w ?? 12240,
      height: pageSize?.h ?? 15840,
      landscape: pageSize?.orient === 'landscape',
      top: margins?.top ?? 1440,
      bottom: margins?.bottom ?? 1440,
      left: margins?.left ?? 1440,
      right: margins?.right ?? 1440,
      gutter: margins?.gutter ?? 0,
      header: margins?.header ?? 720,
      footer: margins?.footer ?? 720,
    };
  }

  private setPageOps(c: Extract<Command, { kind: 'setPage' }>): [Operation[], Pos] | null {
    const whole = (n: number) => Number.isFinite(n) && Math.round(n) === n;
    const sizes = [c.width, c.height];
    const margins = [c.top, c.bottom, c.left, c.right, c.gutter, c.header, c.footer];
    // A page an inch or more each way, and margins that leave a text area (an inch each way) on it.
    if (!sizes.every((n) => whole(n) && n >= 1440 && n <= 31680) || !margins.every((n) => whole(n) && n >= 0 && n <= 31680)) return null;
    if (c.left + c.right + c.gutter > c.width - 1440 || c.top + c.bottom > c.height - 1440) return null;
    // A new page size can't start part way down a page: from the caret on, it starts a page.
    return this.editSections(c.scope, 'nextPage', (section) => {
      const next = structuredClone(section);
      next.pageSize = { ...next.pageSize, w: c.width, h: c.height, orient: c.landscape ? 'landscape' : 'portrait' };
      next.margins = { ...next.margins, top: c.top, bottom: c.bottom, left: c.left, right: c.right, gutter: c.gutter, header: c.header, footer: c.footer };
      return next;
    });
  }

  /**
   * Changes the section properties of the whole document, of the section the caret is in, or from
   * the caret on (the paragraph is split there, the first half ends a section as the old one was,
   * and the rest is the old section's end with the change, starting as a `type` section break).
   */
  private editSections(scope: 'document' | 'section' | 'forward', type: 'continuous' | 'nextPage', change: (section: SectionProperties) => SectionProperties): [Operation[], Pos] | null {
    const ops: Operation[] = [];
    const [start] = this.ordered();
    const end = this.sectionEnd(start.paragraph);
    if (scope === 'document') {
      for (const p of this.paragraphs()) if (p.properties.section) ops.push(this.setProperties(p, { section: change(p.properties.section) }));
      ops.push({ type: 'setDocumentSection', properties: change(this.doc.section) });
    } else if (scope === 'section') {
      if (end) ops.push(this.setProperties(end, { section: change(end.properties.section!) }));
      else ops.push({ type: 'setDocumentSection', properties: change(this.doc.section) });
    } else {
      if (this.replica.engine.index.locate(start.paragraph)) return null;
      const old = structuredClone(end?.properties.section ?? this.doc.section);
      const [splitting, caret] = this.splitOps(start);
      const split = splitting.find((op): op is Extract<Operation, { type: 'split' }> => op.type === 'split')!;
      ops.push(...splitting, { type: 'setParagraphProperties', paragraph: this.replica.id(start.paragraph), properties: { ...structuredClone(start.paragraph.properties), section: structuredClone(old) } });
      const after = { ...change(old), type };
      if (end === start.paragraph) ops.push({ type: 'setParagraphProperties', paragraph: split.id, properties: { ...split.properties, section: after } });
      else if (end) ops.push(this.setProperties(end, { section: after }));
      else ops.push({ type: 'setDocumentSection', properties: after });
      return [ops, caret];
    }
    return [ops, this.selectionIds.focus];
  }

  // --- Table structure -------------------------------------------------------------------

  /** Whether the selection is in a table cell (for the Table menu). */
  inTable(): boolean {
    return !!this.replica.engine.index.locate(this.selection.focus.paragraph);
  }

  /** Each real row of a table with its cells and the grid columns [from, to) each covers. */
  private gridOf(table: Table): { row: TableRow; cells: { cell: TableCell; from: number; to: number }[] }[] {
    return table.rows
      .filter((r): r is TableRow => r.kind === 'row')
      .map((row) => {
        let at = row.properties.gridBefore ?? 0;
        const cells: { cell: TableCell; from: number; to: number }[] = [];
        for (const cell of row.cells) {
          if (cell.kind !== 'cell') continue;
          const span = Math.max(cell.properties.gridSpan ?? 1, 1);
          cells.push({ cell, from: at, to: at + span });
          at += span;
        }
        return { row, cells };
      });
  }

  /** The table the selection is in, with the rows and grid columns it touches: null outside a table. */
  private tableSelection() {
    const [start, end] = this.ordered();
    const index = this.replica.engine.index;
    const a = index.locate(start.paragraph);
    if (!a) return null;
    const b = index.locate(end.paragraph);
    const grid = this.gridOf(a.table);
    const rowOf = (l: { row: TableRow }) => grid.findIndex((g) => g.row === l.row);
    const spanOf = (l: { row: TableRow; cell: TableCell }) => grid[rowOf(l)]?.cells.find((c) => c.cell === l.cell);
    const other = b && b.table === a.table ? b : a;
    const sa = spanOf(a);
    const sb = spanOf(other);
    if (!sa || !sb) return null;
    const ra = rowOf(a);
    const rb = rowOf(other);
    return { table: a.table, grid, first: Math.min(ra, rb), last: Math.max(ra, rb), from: Math.min(sa.from, sb.from), to: Math.max(sa.to, sb.to) };
  }

  private firstParagraphId(cells: readonly (TableCell | { kind: string })[]): string | undefined {
    const p = paragraphsIn(cells.flatMap((c) => (c.kind === 'cell' ? (c as TableCell).children : [])))[0];
    return p && this.replica.id(p);
  }

  /** Makes ids no paragraph has, all different (also from each other before they are added). */
  private idMaker(): () => string {
    const taken = new Set<string>();
    return () => {
      let id: string;
      do id = this.replica.newId();
      while (taken.has(id));
      taken.add(id);
      return id;
    };
  }

  /** An empty cell like another: its width and look, one empty paragraph (in the same style). */
  private blankCell(like: TableCell, fresh: () => string, properties: TableCellProperties = {}): TableCell {
    const { vMerge: _v, hMerge: _h, gridSpan: _g, ...kept } = structuredClone(like.properties);
    const source = paragraphsIn(like.children)[0];
    const { numbering: _n, section: _s, ...paragraphProperties } = structuredClone(source?.properties ?? {});
    return { kind: 'cell', properties: { ...kept, ...properties }, attrs: {}, children: [{ kind: 'paragraph', properties: paragraphProperties, children: [], attrs: { 'w14:paraId': fresh() } }] };
  }

  private tableEdit(edit: TableEdit): CommandResult {
    const sel = this.tableSelection();
    if (!sel) return NO_CHANGE;
    if (edit === 'selectTable') {
      const ps = paragraphsIn([sel.table]);
      this.selection = { anchor: { paragraph: ps[0], offset: 0 }, focus: { paragraph: ps[ps.length - 1], offset: paragraphLength(ps[ps.length - 1]) } };
      return NO_CHANGE;
    }
    if (edit === 'mergeCells') {
      const merged = mergeCells(sel.table, { first: sel.first, last: sel.last, from: sel.from, to: sel.to }, this.idMaker());
      return this.edit(merged && this.replaceTable(sel.table, merged.table, merged.caret));
    }
    const plan =
      edit === 'insertRowAbove' || edit === 'insertRowBelow'
        ? this.insertRowsOps(sel, edit === 'insertRowAbove')
        : edit === 'insertColumnLeft' || edit === 'insertColumnRight'
          ? this.insertColumnsOps(sel, edit === 'insertColumnLeft')
          : edit === 'deleteRows'
            ? this.deleteRowsOps(sel)
            : edit === 'deleteColumns'
              ? this.deleteColumnsOps(sel)
              : this.deleteTableOps(sel.table);
    return this.edit(plan);
  }

  private insertRowsOps(sel: NonNullable<ReturnType<Editor['tableSelection']>>, above: boolean): [Operation[], Pos] | null {
    const reference = sel.grid[above ? sel.first : sel.last].row;
    const anchor = this.firstParagraphId(reference.cells);
    if (!anchor) return null;
    const fresh = this.idMaker();
    // As many rows as are selected, each like the row beside them.
    const ops: Operation[] = [];
    for (let i = sel.first; i <= sel.last; i++) {
      const { header: _header, ...properties } = structuredClone(reference.properties);
      const cells = reference.cells.filter((c): c is TableCell => c.kind === 'cell').map((c) => this.blankCell(c, fresh, { gridSpan: c.properties.gridSpan }));
      ops.push({ type: 'insertRow', paragraph: anchor, after: !above, row: { kind: 'row', properties, cells, attrs: {} } });
    }
    return [ops, this.selectionIds.focus];
  }

  /** Width of the grid columns [from, to) in a grid, twips. */
  private span(widths: number[], from: number, to: number): number {
    let sum = 0;
    for (let c = from; c < to; c++) sum += widths[c] ?? 0;
    return sum;
  }

  private setWidth(properties: TableCellProperties, width: number, gridSpan?: number): TableCellProperties | null {
    const next: TableCellProperties = { ...properties };
    if (properties.width?.type === 'dxa') next.width = { ...properties.width, w: String(Math.round(width)) };
    if (gridSpan !== undefined) {
      if (gridSpan > 1) next.gridSpan = gridSpan;
      else delete next.gridSpan;
    }
    return JSON.stringify(next) === JSON.stringify(properties) ? null : next;
  }

  private insertColumnsOps(sel: NonNullable<ReturnType<Editor['tableSelection']>>, left: boolean): [Operation[], Pos] | null {
    const { table, grid } = sel;
    // Without a grid there are no columns to add to.
    if (table.grid.length === 0) return null;
    const g = left ? sel.from : sel.to;
    const width = table.grid[left ? sel.from : sel.to - 1] ?? 1440;
    let widths = [...table.grid];
    widths.splice(g, 0, width);
    // Wider than the page: every column narrows to fit.
    const total = widths.reduce((a, b) => a + b, 0);
    const limit = this.textWidth();
    if (total > limit) widths = widths.map((w) => Math.max(Math.floor((w * limit) / total), 1));
    const firstRow = grid[0]?.row;
    const anchor = firstRow && this.firstParagraphId(firstRow.cells);
    if (!anchor) return null;
    const fresh = this.idMaker();
    const ops: Operation[] = [{ type: 'setTableGrid', paragraph: anchor, grid: widths }];
    for (const { cells } of grid) {
      const reference = cells.find((c) => c.from <= g && g < c.to) ?? cells[cells.length - 1];
      if (!reference) continue;
      for (const c of cells) {
        const id = this.firstParagraphId([c.cell]);
        if (!id) continue;
        // A cell across the new column gets wider; ones after it move over; the rest keep their place.
        const crossing = c.from < g && g < c.to;
        const from = c.from >= g ? c.from + 1 : c.from;
        const to = c.to > g || crossing ? c.to + 1 : c.to;
        const next = this.setWidth(c.cell.properties, this.span(widths, from, to), crossing ? c.to - c.from + 1 : undefined);
        if (next) ops.push({ type: 'setCellProperties', paragraph: id, properties: next });
      }
      // A row whose cells cross the new column has nothing to add; the others get a cell.
      if (cells.some((c) => c.from < g && g < c.to)) continue;
      const before = cells.find((c) => c.from >= g);
      const target = before ?? cells[cells.length - 1];
      const id = this.firstParagraphId([target.cell]);
      if (id) ops.push({ type: 'insertCell', paragraph: id, after: !before, cell: this.blankCell(reference.cell, fresh, { width: reference.cell.properties.width?.type === 'dxa' ? { w: String(widths[g]), type: 'dxa' } : reference.cell.properties.width }) });
    }
    return [ops, this.selectionIds.focus];
  }

  private deleteRowsOps(sel: NonNullable<ReturnType<Editor['tableSelection']>>): [Operation[], Pos] | null {
    if (sel.first === 0 && sel.last === sel.grid.length - 1) return this.deleteTableOps(sel.table);
    const ops: Operation[] = [];
    for (let i = sel.first; i <= sel.last; i++) {
      const id = this.firstParagraphId(sel.grid[i].row.cells);
      if (id) ops.push({ type: 'removeRow', paragraph: id });
    }
    // The caret goes to the row that takes their place (or the one before, at the end of the table).
    const survivor = sel.grid[sel.last + 1] ?? sel.grid[sel.first - 1];
    const id = survivor && this.firstParagraphId(survivor.row.cells);
    return id ? [ops, { paragraph: id, offset: 0 }] : null;
  }

  private deleteColumnsOps(sel: NonNullable<ReturnType<Editor['tableSelection']>>): [Operation[], Pos] | null {
    const { table, grid } = sel;
    const columns = Math.max(table.grid.length, ...grid.map((g) => g.cells[g.cells.length - 1]?.to ?? 0));
    if (sel.from <= 0 && sel.to >= columns) return this.deleteTableOps(table);
    const removed = sel.to - sel.from;
    const widths = [...table.grid];
    widths.splice(sel.from, removed);
    const firstRow = grid[0]?.row;
    const anchor = firstRow && this.firstParagraphId(firstRow.cells);
    if (!anchor) return null;
    const ops: Operation[] = widths.length ? [{ type: 'setTableGrid', paragraph: anchor, grid: widths }] : [];
    let caret: Pos | null = null;
    for (const { cells } of grid) {
      for (const c of cells) {
        const id = this.firstParagraphId([c.cell]);
        if (!id) continue;
        const overlap = Math.min(c.to, sel.to) - Math.max(c.from, sel.from);
        if (overlap >= c.to - c.from) {
          ops.push({ type: 'removeCell', paragraph: id });
          continue;
        }
        // Each edge moves left by the deleted columns before it: left of them a cell stays, right of them it moves, across them it narrows.
        const shift = (x: number) => x - Math.min(Math.max(x - sel.from, 0), removed);
        const from = shift(c.from);
        const to = shift(c.to);
        const next = this.setWidth(c.cell.properties, this.span(widths, from, to), overlap > 0 ? c.to - c.from - overlap : undefined);
        if (next) ops.push({ type: 'setCellProperties', paragraph: id, properties: next });
        if (!caret && c === cells.find((x) => x.from >= sel.to)) caret = { paragraph: id, offset: 0 };
      }
    }
    return [ops, caret ?? { paragraph: anchor, offset: 0 }];
  }

  private deleteTableOps(table: Table): [Operation[], Pos] | null {
    const container = this.replica.engine.index.container(table);
    if (!container) return null;
    const i = container.indexOf(table);
    const previous = container[i - 1];
    const next = container[i + 1];
    const key = blockKey(table);
    // Removed from beside a paragraph: the one before it, or (a table at the start) the one after.
    if (previous?.kind === 'paragraph') {
      const id = this.replica.id(previous);
      return [[{ type: 'removeBlocks', after: id, keys: [key] }], { paragraph: id, offset: paragraphLength(previous) }];
    }
    if (next?.kind === 'paragraph') {
      const id = this.replica.id(next);
      return [[{ type: 'removeBlocks', after: id, keys: [key], before: true }], { paragraph: id, offset: 0 }];
    }
    return null;
  }

  /** Puts `next` in the place of a table, as one edit (and one undo step): the old one goes, the new one comes. */
  private replaceTable(old: Table, next: Table, caret: Paragraph): [Operation[], Pos] | null {
    const container = this.replica.engine.index.container(old);
    if (!container) return null;
    const i = container.indexOf(old);
    const previous = container[i - 1];
    const following = container[i + 1];
    // Beside a paragraph: the one before it, or (a table first in its container) the one after.
    const before = previous?.kind !== 'paragraph';
    const anchor = previous?.kind === 'paragraph' ? previous : following?.kind === 'paragraph' ? following : null;
    if (!anchor) return null;
    const id = this.replica.id(anchor);
    const side = before ? { before: true } : {};
    return [[{ type: 'removeBlocks', after: id, keys: [blockKey(old)], ...side }, { type: 'insertBlocks', after: id, blocks: [next], ...side }], { paragraph: caret.attrs['w14:paraId'], offset: 0 }];
  }

  private splitCells(columns: number, rows: number): CommandResult {
    const sel = this.tableSelection();
    const [start] = this.ordered();
    const at = sel && this.replica.engine.index.locate(start.paragraph);
    if (!sel || !at) return NO_CHANGE;
    const row = sel.grid.findIndex((g) => g.row === at.row);
    const span = sel.grid[row]?.cells.find((c) => c.cell === at.cell);
    if (!span) return NO_CHANGE;
    const split = splitCell(sel.table, row, span.from, Math.floor(columns), Math.floor(rows), this.idMaker());
    return this.edit(split && this.replaceTable(sel.table, split.table, split.caret));
  }

  private selectCell(cell: TableCell): void {
    const ps = paragraphsIn(cell.children);
    if (ps.length === 0) return;
    this.selection = { anchor: { paragraph: ps[0], offset: 0 }, focus: { paragraph: ps[ps.length - 1], offset: paragraphLength(ps[ps.length - 1]) } };
  }

  private tab(backward: boolean): CommandResult {
    const [, end] = this.ordered();
    const at = this.replica.engine.index.locate(end.paragraph);
    if (!at) return backward ? NO_CHANGE : this.apply({ kind: 'insertText', text: '\t' });
    const cells = this.gridOf(at.table).flatMap((g) => g.cells.map((c) => c.cell));
    const here = cells.indexOf(at.cell);
    const target = cells[here + (backward ? -1 : 1)];
    if (target) {
      this.selectCell(target);
      return NO_CHANGE;
    }
    if (backward) return NO_CHANGE;
    // Tab in the last cell adds a row and goes to its first cell.
    const sel = this.tableSelection();
    if (!sel) return NO_CHANGE;
    const [ops] = this.insertRowsOps({ ...sel, first: sel.grid.length - 1, last: sel.grid.length - 1 }, false) ?? [[]];
    const first = ops[0]?.type === 'insertRow' ? this.firstPara(ops[0].row) : undefined;
    return this.edit(ops.length && first ? [ops, { paragraph: first, offset: 0 }] : null);
  }

  private firstPara(row: TableRow): string | undefined {
    return paragraphsIn(row.cells.flatMap((c) => (c.kind === 'cell' ? c.children : [])))[0]?.attrs['w14:paraId'];
  }

  // --- Links -----------------------------------------------------------------------------

  /** The hyperlink at a position (a caret counts at either end of it), with its range. */
  linkAt(paragraph: Paragraph, offset: number, inclusive = true): { link: Hyperlink; from: number; to: number } | null {
    let pos = 0;
    let found: { link: Hyperlink; from: number; to: number } | null = null;
    const walk = (inlines: readonly Inline[]): void => {
      for (const inline of inlines) {
        const length = inlineLength(inline);
        if (found) return;
        if (inline.kind === 'hyperlink' && (inclusive ? offset >= pos && offset <= pos + length : offset >= pos && offset < pos + length)) {
          found = { link: inline, from: pos, to: pos + length };
          return;
        }
        if (inline.kind === 'wrapper' || inline.kind === 'hyperlink') {
          const start = pos;
          walk(inline.children);
          pos = start + length;
        } else pos += length;
      }
    };
    walk(paragraph.children);
    return found;
  }

  /** The address of the link whose text is under the page point (x, y), or null when the point is not over one. */
  linkUnder(page: PageLayout, x: number, y: number): string | null {
    const line = page.lines.find((l) => y >= l.y && y <= l.y + l.height && x >= l.x && x <= l.x + l.width);
    if (!line) return null;
    // The character the point is over: the last caret stop at or before it (the final stop is the line's end, not a character).
    let k = 0;
    for (let i = 0; i < line.stops.length - 1; i++) if (line.column + line.stops[i] <= x) k = i;
    const at = this.linkAt(line.paragraph, toModel(line.spans, line.start + k), false);
    return at ? (at.link.url ?? (at.link.anchor ? `#${at.link.anchor}` : '')) : null;
  }

  /** The equation the selection is exactly (one selected position holding one), for Insert Equation to edit. */
  selectedMath(): MathEquation | null {
    if (this.collapsed) return null;
    const [start, end] = this.ordered();
    if (start.paragraph !== end.paragraph || end.offset - start.offset !== 1) return null;
    const at = mathAt(start.paragraph, start.offset);
    if (!at) return null;
    return readMathInline(at);
  }

  /** The position of the equation under a point on a page, if the point is over one. */
  mathUnder(page: PageLayout, x: number, y: number): Position | null {
    const line = page.lines.find((l) => y >= l.y && y <= l.y + l.height && x >= l.x && x <= l.x + l.width);
    if (!line) return null;
    for (let i = 0; i < line.stops.length - 1; i++) {
      if (x < line.column + line.stops[i] || x >= line.column + line.stops[i + 1]) continue;
      const offset = toModel(line.spans, line.start + i);
      return mathAt(line.paragraph, offset) ? { paragraph: line.paragraph, offset } : null;
    }
    return null;
  }

  /** The link at the selection (its start, if it's a range), for the toolbar and the Insert Hyperlink dialog. */
  selectedLink(): { url: string; text: string } | null {
    const [start] = this.ordered();
    const at = this.linkAt(start.paragraph, start.offset, this.collapsed);
    if (!at) return null;
    return { url: at.link.url ?? (at.link.anchor ? `#${at.link.anchor}` : ''), text: plainText(start.paragraph, at.from, at.to) };
  }

  /** The runs of `inlines` as link text (or, with `link` false, as plain text): the Hyperlink character style on or off. */
  private restyled(inlines: readonly Inline[], link: boolean): Inline[] {
    const out: Inline[] = [];
    for (const inline of inlines) {
      if (inline.kind === 'hyperlink') out.push(...this.restyled(inline.children, link));
      else if (inline.kind === 'run') {
        const copy = structuredClone(inline);
        if (link) copy.properties.style = 'Hyperlink';
        else if (copy.properties.style === 'Hyperlink') delete copy.properties.style;
        out.push(copy);
      } else out.push(structuredClone(inline));
    }
    return out;
  }

  /** The style link text uses, when the document doesn't have it yet. */
  private linkStyleOps(): Operation[] {
    if (this.doc.styles.styles.some((s) => s.id === 'Hyperlink')) return [];
    return [
      {
        type: 'setStyle',
        id: 'Hyperlink',
        style: {
          type: 'character',
          id: 'Hyperlink',
          name: 'Hyperlink',
          basedOn: 'DefaultParagraphFont',
          runProperties: { color: { val: '0563C1', themeColor: 'hyperlink' }, underline: { val: 'single' } },
          attrs: {},
        },
      },
    ];
  }

  private setLinkOps(url: string, text: string): [Operation[], Pos] | null {
    const [start, end] = this.ordered();
    // A link lives in one paragraph.
    if (start.paragraph !== end.paragraph || !url) return null;
    const p = start.paragraph;
    const existing = this.linkAt(p, start.offset, this.collapsed);
    const from = existing ? Math.min(start.offset, existing.from) : start.offset;
    const to = existing ? Math.max(end.offset, existing.to) : end.offset;
    const [, rest] = splitInlines(p.children, from);
    const [middle] = splitInlines(rest, to - from);
    let children: Inline[];
    if (to > from && (!text || text === plainText(p, from, to))) children = this.restyled(middle, true);
    else {
      const properties = structuredClone(runPropertiesAt(p, from) ?? {});
      properties.style = 'Hyperlink';
      children = [{ kind: 'run', properties, content: [{ kind: 'text', text: text || url }], attrs: {} }];
    }
    const id = this.replica.id(p);
    const ops: Operation[] = [...this.linkStyleOps()];
    if (to > from) ops.push({ type: 'delete', paragraph: id, from, to });
    ops.push({ type: 'insertContent', paragraph: id, offset: from, content: [{ kind: 'hyperlink', url, children, attrs: {} }] });
    return [ops, { paragraph: id, offset: from + inlinesLength(children) }];
  }

  private removeLinkOps(): [Operation[], Pos] | null {
    const [start] = this.ordered();
    const existing = this.linkAt(start.paragraph, start.offset, this.collapsed);
    if (!existing) return null;
    const children = this.restyled(existing.link.children, false);
    const id = this.replica.id(start.paragraph);
    const ops: Operation[] = [
      { type: 'delete', paragraph: id, from: existing.from, to: existing.to },
      { type: 'insertContent', paragraph: id, offset: existing.from, content: children },
    ];
    return [ops, { paragraph: id, offset: existing.from + inlinesLength(children) }];
  }

  // --- Find and replace ------------------------------------------------------------------

  /** Where each match of `text` starts in a paragraph (model offsets), not overlapping. */
  private matches(paragraph: Paragraph, text: string, matchCase: boolean, wholeWord = false): number[] {
    if (!text) return [];
    const original = paragraphText(paragraph);
    const haystack = matchCase ? original : original.toLowerCase();
    const needle = matchCase ? text : text.toLowerCase();
    // Lower-casing can change a string's length (İ): then offsets no longer line up, so skip it.
    if (haystack.length !== original.length) return [];
    const found: number[] = [];
    const cjk = wholeWord ? cjkWords(original) : null;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
      // Whole words only: what's either side isn't part of a word.
      if (cjk) {
        if (isWordBoundary(cjk, at) && isWordBoundary(cjk, at + needle.length)) found.push(at);
      } else if (!wholeWord || (!WORD.test(original[at - 1] ?? ' ') && !WORD.test(original[at + needle.length] ?? ' '))) found.push(at);
    }
    return found;
  }

  private find(text: string, matchCase: boolean, backward: boolean, wholeWord: boolean): boolean {
    const list = this.paragraphs();
    if (!text || !list.length) return false;
    const [start, end] = this.ordered();
    const from = this.indexOf(backward ? start.paragraph : end.paragraph);
    // Every paragraph once from the selection, then the one it began in again for matches before it.
    for (let step = 0; step <= list.length; step++) {
      const k = (backward ? from - step : from + step) % list.length;
      const paragraph = list[(k + list.length) % list.length];
      let offsets = this.matches(paragraph, text, matchCase, wholeWord);
      if (step === 0) offsets = offsets.filter((o) => (backward ? o + text.length <= start.offset : o >= end.offset));
      else if (step === list.length) offsets = offsets.filter((o) => (backward ? o + text.length > start.offset : o < end.offset));
      const at = backward ? offsets[offsets.length - 1] : offsets[0];
      if (at === undefined) continue;
      this.selection = { anchor: { paragraph, offset: at }, focus: { paragraph, offset: at + text.length } };
      return true;
    }
    return false;
  }

  private replaceAll(text: string, replacement: string, matchCase: boolean, wholeWord: boolean): CommandResult {
    const ops: Operation[] = [];
    let count = 0;
    let after: Pos | null = null;
    // A selection that is one of the matches (Change All from the spelling check) stays put, after its replacement.
    const [start, end] = this.ordered();
    let staysAt: Pos | null = null;
    for (const paragraph of this.paragraphs()) {
      const id = this.replica.id(paragraph);
      const found = this.matches(paragraph, text, matchCase, wholeWord);
      if (found.length && !after) after = { paragraph: id, offset: found[0] + replacement.length };
      if (paragraph === start.paragraph && start.paragraph === end.paragraph) {
        const index = found.indexOf(start.offset);
        if (index >= 0 && end.offset === start.offset + text.length) staysAt = { paragraph: id, offset: start.offset + index * (replacement.length - text.length) + replacement.length };
      }
      // From the end, so earlier offsets stay valid as the text changes length.
      for (const at of found.reverse()) {
        // Inserted at the end of the match first, so the replacement looks like the last of the words it replaces.
        if (replacement) ops.push({ type: 'insertText', paragraph: id, offset: at + text.length, text: replacement });
        ops.push({ type: 'delete', paragraph: id, from: at, to: at + text.length });
        count++;
      }
    }
    if (!after) return { ...NO_CHANGE, replaced: 0 };
    after = staysAt ?? after;
    // The caret ends after the first replacement (or the selected one); the old selection's offsets may no longer hold.
    const change = this.replica.edit(ops, { before: this.selectionIds, after: { anchor: after, focus: after } });
    return { ...this.changed(change.applied, { anchor: after, focus: after }), replaced: count };
  }

  // --- Formatting ------------------------------------------------------------------------

  /** Paragraphs the selection touches, in order (the end one only if the selection reaches into it). */
  selectedParagraphs(): Paragraph[] {
    const [start, end] = this.ordered();
    const list = this.paragraphs();
    const last = end.offset === 0 && end.paragraph !== start.paragraph ? this.indexOf(end.paragraph) - 1 : this.indexOf(end.paragraph);
    return list.slice(this.indexOf(start.paragraph), last + 1);
  }

  /** The word a caret is inside (not at either edge of), if any. */
  private wordAround(pos: Position): [Position, Position] | null {
    const text = paragraphText(pos.paragraph);
    const cjk = cjkWords(text);
    if (cjk) {
      const s = segmentAt(cjk, pos.offset);
      return s?.word && s.start < pos.offset ? this.wordAt(pos) : null;
    }
    if (!WORD.test(text[pos.offset - 1] ?? '') || !WORD.test(text[pos.offset] ?? '')) return null;
    return this.wordAt(pos);
  }

  private formatText(command: Extract<Command, { kind: 'formatText' }>): CommandResult {
    const { format } = command;
    const ops = [...(command.define ?? [])];
    const formatRange = (p: Paragraph, from: number, to: number) => {
      const id = this.replica.id(p);
      if (typeof format !== 'function') {
        ops.push({ type: 'formatText', paragraph: id, from, to, format });
        return;
      }
      for (const run of runsIn(p, from, to)) {
        const change = format(run.properties, p);
        if (!change) continue;
        const last = ops.at(-1);
        if (last?.type === 'formatText' && last.paragraph === id && last.to === run.from && JSON.stringify(last.format) === JSON.stringify(change)) last.to = run.to;
        else ops.push({ type: 'formatText', paragraph: id, from: run.from, to: run.to, format: change });
      }
    };
    /** An empty paragraph's mark carries the formatting typed text there gets. */
    const formatMark = (p: Paragraph) => {
      const current = p.properties.runProperties ?? {};
      const change = typeof format === 'function' ? format(current, p) : format;
      if (change) ops.push(this.setProperties(p, { runProperties: withFormat(current, change) }));
    };

    if (this.collapsed) {
      const at = this.selection.focus;
      const word = this.wordAround(at);
      if (word) formatRange(at.paragraph, word[0].offset, word[1].offset);
      else if (paragraphLength(at.paragraph) === 0) formatMark(at.paragraph);
      else {
        // Nothing to format yet: it applies to what's typed next here.
        const current = withFormat(runPropertiesAt(at.paragraph, at.offset) ?? {}, this.pending ?? {});
        const change = typeof format === 'function' ? format(current, at.paragraph) : format;
        if (change) this.pending = { ...this.pending, ...change };
        return ops.length ? this.editInPlace(ops) : NO_CHANGE;
      }
      return this.editInPlace(ops);
    }
    const [start, end] = this.ordered();
    for (const p of this.selectedParagraphs()) {
      const from = p === start.paragraph ? start.offset : 0;
      const to = p === end.paragraph ? end.offset : paragraphLength(p);
      if (paragraphLength(p) === 0) formatMark(p);
      else if (to > from) formatRange(p, from, to);
    }
    return this.editInPlace(ops);
  }

  private changeCaseOps(change: (text: string) => string): Operation[] {
    let [start, end] = this.ordered();
    if (this.collapsed) {
      const word = this.wordAround(start);
      if (!word) return [];
      [start, end] = word;
    }
    const ops: Operation[] = [];
    for (const p of this.selectedParagraphs()) {
      const from = p === start.paragraph ? start.offset : 0;
      const to = p === end.paragraph ? end.offset : paragraphLength(p);
      const text = paragraphText(p);
      const changed = change(text.slice(from, to));
      if (changed.length !== to - from) continue;
      const id = this.replica.id(p);
      // Each run's text is replaced by a run with its formatting; objects (tabs, fields) stay.
      for (const run of runsIn(p, from, to)) {
        if (run.nested) continue;
        let a = run.from;
        while (a < run.to) {
          let b = a;
          while (b < run.to && text[b] !== OBJECT_CHAR) b++;
          const next = changed.slice(a - from, b - from);
          if (b > a && next !== text.slice(a, b)) {
            ops.push({ type: 'delete', paragraph: id, from: a, to: b });
            ops.push({ type: 'insertContent', paragraph: id, offset: a, content: [{ kind: 'run', properties: structuredClone(run.properties), content: [{ kind: 'text', text: next }], attrs: {} }] });
          }
          a = b + 1;
        }
      }
    }
    return ops;
  }

  /** Applies operations that don't move text as one local edit, keeping the selection. */
  private editInPlace(ops: Operation[]): CommandResult {
    if (ops.length === 0) return NO_CHANGE;
    const selection = this.selectionIds;
    const change = this.replica.edit(ops, { before: selection, after: selection });
    return this.changed(change.applied, selection);
  }

  // --- Comments --------------------------------------------------------------------------

  /** A comment id no comment or marker in the document has (decimal, as w:id is). */
  private newCommentId(): string {
    // Random so that two people commenting at once don't collide.
    const taken = new Set([...this.doc.comments.map((c) => c.id), ...commentRanges(this.paragraphs()).keys()]);
    let id: string;
    do id = String(Math.floor(Math.random() * 0x7fffffff));
    while (taken.has(id));
    return id;
  }

  private static now(): string {
    return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  }

  /** The comment that starts the thread this one is in. */
  private threadRoot(id: string): Comment | undefined {
    let comment = this.doc.comments.find((c) => c.id === id);
    for (let hops = 0; comment?.parentId && hops < 100; hops++) {
      const parent = this.doc.comments.find((c) => c.id === comment!.parentId);
      if (!parent) break;
      comment = parent;
    }
    return comment;
  }

  /** The operations that put a comment's markers at a range: end first, so the start's offset still holds. */
  private markerOps(id: string, start: Pos, end: Pos): Operation[] {
    return [
      { type: 'insertContent', paragraph: end.paragraph, offset: end.offset, content: [commentEnd(id), commentReference(id)] },
      { type: 'insertContent', paragraph: start.paragraph, offset: start.offset, content: [commentStart(id)] },
    ];
  }

  private addCommentOps(command: Extract<Command, { kind: 'addComment' }>): [Operation[], Pos] {
    let [start, end] = this.ordered();
    if (this.collapsed) [start, end] = this.wordAt(start);
    const id = this.newCommentId();
    const startPos = this.pos(start);
    const endPos = this.pos(end);
    const ops: Operation[] = [
      { type: 'setComment', id, comment: { id, author: command.author, date: command.date ?? Editor.now(), paragraphs: command.text.split(/\r\n?|\n/) } },
      ...this.markerOps(id, startPos, endPos),
    ];
    const shift = start.paragraph === end.paragraph ? 1 : 0;
    return [ops, { paragraph: endPos.paragraph, offset: endPos.offset + shift + 2 }];
  }

  private replyCommentOps(command: Extract<Command, { kind: 'replyComment' }>): [Operation[], Pos] | null {
    const root = this.threadRoot(command.id);
    const range = root && commentRanges(this.paragraphs()).get(root.id);
    if (!root || !range) return null;
    const id = this.newCommentId();
    const startPos = this.pos(range.start);
    const endPos = this.pos(range.end);
    const ops: Operation[] = [
      { type: 'setComment', id, comment: { id, author: command.author, date: command.date ?? Editor.now(), paragraphs: command.text.split(/\r\n?|\n/), parentId: root.id } },
      ...this.markerOps(id, startPos, endPos),
    ];
    const shift = range.start.paragraph === range.end.paragraph ? 1 : 0;
    return [ops, { paragraph: endPos.paragraph, offset: endPos.offset + shift + 2 }];
  }

  private deleteCommentOps(id: string): [Operation[], Pos] | null {
    // A thread's first comment takes its replies with it.
    const ids = [id, ...this.doc.comments.filter((c) => c.parentId === id).map((c) => c.id)];
    const ops: Operation[] = [];
    for (const p of this.paragraphs()) {
      const offsets = ids.flatMap((i) => commentMarkerOffsets(p, i)).sort((a, b) => b - a);
      for (const offset of offsets) ops.push({ type: 'delete', paragraph: this.replica.id(p), from: offset, to: offset + 1 });
    }
    for (const i of ids) if (this.doc.comments.some((c) => c.id === i)) ops.push({ type: 'setComment', id: i, comment: null });
    if (!ops.length) return null;
    // Keep the caret where it is, moved back over any markers before it.
    const focus = this.selection.focus;
    const before = ids.reduce((n, i) => n + commentMarkerOffsets(focus.paragraph, i).filter((o) => o < focus.offset).length, 0);
    return [ops, { paragraph: this.replica.id(focus.paragraph), offset: focus.offset - before }];
  }

  /**
   * Rectangles over ranges of the text on the pages shown (spelling marks). `rangesOf` gives a
   * paragraph's ranges as model offsets, and is asked once per paragraph that has a line in view.
   */
  marks<K>(rangesOf: (paragraph: Paragraph) => { start: number; end: number; kind: K }[]): (Rect & { kind: K })[] {
    const cache = new Map<Paragraph, { start: number; end: number; kind: K }[]>();
    const marks: (Rect & { kind: K })[] = [];
    for (const page of this.session.displayPages) {
      for (const line of page.lines) {
        let ranges = cache.get(line.paragraph);
        if (!ranges) cache.set(line.paragraph, (ranges = rangesOf(line.paragraph)));
        for (const range of ranges) {
          const a = Math.max(toVisible(line.spans, range.start), line.start);
          const b = Math.min(toVisible(line.spans, range.end), line.end);
          if (a >= b) continue;
          const x1 = line.column + line.stops[a - line.start];
          const x2 = line.column + line.stops[b - line.start];
          if (x2 > x1) marks.push({ page, x: x1, y: line.y, width: x2 - x1, height: line.height, kind: range.kind });
        }
      }
    }
    return marks;
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
        ...(c.initials && { initials: c.initials }),
        ...(c.date && { date: c.date }),
        ...(c.parentId && { parentId: c.parentId }),
        ...(c.resolved && { resolved: true }),
        text: c.paragraphs.join('\n'),
        rects: range ? this.rangeRects(range.start, range.end) : [],
      };
    });
  }

  /** The thread (its first comment's id) whose text the caret is in, if any. */
  activeComment(): string | null {
    if (!this.doc.comments.length) return null;
    const focus = this.selection.focus;
    let best: { id: string; size: number } | null = null;
    for (const [id, range] of commentRanges(this.paragraphs())) {
      const root = this.threadRoot(id);
      if (!root || root.id !== id) continue;
      if (this.compare(focus, range.start) < 0 || this.compare(focus, range.end) > 0) continue;
      // The innermost of nested ranges: the shortest, by the paragraphs and offsets it spans.
      const size = (this.indexOf(range.end.paragraph) - this.indexOf(range.start.paragraph)) * 1e6 + range.end.offset - range.start.offset;
      if (!best || size < best.size) best = { id, size };
    }
    return best?.id ?? null;
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
    if (applied.styles) this.session.invalidateStyles();
    this.session.invalidate(applied.changed, { structural: applied.structural });
    if (selection) this.setSelectionIds(selection);
    else this.setSelectionIds(this.selectionIds);
    return { edited: true, changed: applied.changed, structural: applied.structural, styles: applied.styles };
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
    if (change.styles) this.session.invalidateStyles();
    this.session.invalidate(change.changed, { structural: change.structural });
    this.setSelectionIds(selection);
    return { result: { edited: true, changed: change.changed, structural: change.structural, styles: change.styles }, change };
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

  private setProperties(p: Paragraph, changes: ParagraphFormat): Operation {
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
      return [Math.min(from, graphemeAt(text, pos.offset - 1)?.[0] ?? from), pos.offset];
    }
    const v = toVisible(spans, pos.offset);
    if (v <= 0) return null;
    const range = charRange(spans, v - 1);
    if (range[1] - range[0] === 1 && range[0] > 0 && isLow(text.charCodeAt(range[0])) && isHigh(text.charCodeAt(range[0] - 1))) range[0]--;
    range[0] = Math.min(range[0], graphemeAt(text, range[1] - 1)?.[0] ?? range[0]);
    return range;
  }

  /** Model range of the visible character after a position (null at the end). */
  private charAfter(pos: Position): [number, number] | null {
    const spans = this.spans(pos.paragraph);
    const text = paragraphText(pos.paragraph);
    if (!spans) {
      if (pos.offset >= text.length) return null;
      const to = isHigh(text.charCodeAt(pos.offset)) && isLow(text.charCodeAt(pos.offset + 1)) ? pos.offset + 2 : pos.offset + 1;
      return [pos.offset, Math.max(to, graphemeAt(text, pos.offset)?.[1] ?? to)];
    }
    const v = toVisible(spans, pos.offset);
    if (v >= visibleLength(spans)) return null;
    const range = charRange(spans, v);
    if (range[1] - range[0] === 1 && isHigh(text.charCodeAt(range[0])) && isLow(text.charCodeAt(range[1]))) range[1]++;
    range[1] = Math.max(range[1], graphemeAt(text, range[0])?.[1] ?? range[1]);
    return range;
  }

  /** Start of this or the previous word (across a paragraph start). */
  private wordLeft(pos: Position): Position {
    const text = paragraphText(pos.paragraph);
    let i = pos.offset;
    if (i === 0) return this.paragraphEdge(pos, -1) ?? pos;
    while (i > 0 && SPACE.test(text[i - 1])) i--;
    const cjk = cjkWords(text);
    if (cjk) {
      const s = i > 0 ? segmentAt(cjk, i - 1) : undefined;
      return { paragraph: pos.paragraph, offset: s ? s.start : i };
    }
    if (i > 0 && WORD.test(text[i - 1])) while (i > 0 && WORD.test(text[i - 1])) i--;
    else if (i > 0) i--;
    return { paragraph: pos.paragraph, offset: i };
  }

  /** Start of the next word (across a paragraph end). */
  private wordRight(pos: Position): Position {
    const text = paragraphText(pos.paragraph);
    let i = pos.offset;
    if (i >= text.length) return this.paragraphEdge(pos, 1) ?? pos;
    const cjk = cjkWords(text);
    if (cjk) {
      const s = segmentAt(cjk, i);
      if (s && !/^\s/u.test(text[s.start])) i = s.end;
      while (i < text.length && SPACE.test(text[i])) i++;
      return { paragraph: pos.paragraph, offset: i };
    }
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
    const cjk = cjkWords(text);
    if (cjk && text.length > 0) {
      const s = segmentAt(cjk, a < text.length ? a : a - 1);
      if (s && !/^\s/u.test(text[s.start])) return [{ paragraph: pos.paragraph, offset: s.start }, { paragraph: pos.paragraph, offset: s.end }];
    }
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
      // Past the end of a column of text: on to the next column (or back to the one before).
      if (page === at.page && current.columnWidth !== undefined && !candidates.some((l) => goal >= l.column - 1 && goal <= l.column + (l.columnWidth ?? 0) + 1)) {
        const next = page.lines[page.lines.indexOf(current) + dir];
        if (next && next.columnWidth !== undefined && next.column !== current.column) return this.positionInLine(next, goal);
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

  private pointer(command: Extract<Command, { kind: 'pointer' }>): void {
    const hit = this.hitTest(command.page, command.x, command.y);
    if (!hit) return;
    if (command.unit === 'word') {
      // A double click on an equation selects it, whole.
      const math = this.mathUnder(command.page, command.x, command.y);
      const [a, b] = math ? [math, { paragraph: math.paragraph, offset: math.offset + 1 }] : this.wordAt(hit);
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

/** Run properties with a formatting change made. */
export function withFormat(properties: RunProperties, format: RunFormat): RunProperties {
  const out = structuredClone(properties) as Record<string, unknown>;
  for (const [key, value] of Object.entries(format)) {
    if (value === null || value === undefined) delete out[key];
    else out[key] = structuredClone(value);
  }
  return out as RunProperties;
}

function combine(a: CommandResult, b: CommandResult): CommandResult {
  if (!a.edited) return b;
  if (!b.edited) return a;
  return { edited: true, changed: new Set([...a.changed, ...b.changed]), structural: a.structural || b.structural, styles: a.styles || b.styles };
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
