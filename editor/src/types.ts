// Positions, selections, commands and results of the editor.

import { type Block, type DocumentProperties, type Drawing, type Inline, type Paragraph, type ParagraphProperties, type RunProperties } from '@golemdocs/docx';
import { type Operation, type RunFormat } from '@golemdocs/ops';
import { type PageLayout } from '@golemdocs/layout';

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
  /** Replaces the vector drawing whose SVG is package part `svg` (or, for '*', the one drawing a document is) with another version of it (it was edited in place), as one undoable step. Its size is kept when the new one has none (0). */
  | { kind: 'replaceDrawing'; svg: string; drawing: Drawing }
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
  | { kind: 'find'; text: string; matchCase?: boolean; backward?: boolean; wholeWord?: boolean; regex?: boolean }
  /** Replaces every match of `text` in the document. */
  | { kind: 'replaceAll'; text: string; with: string; matchCase?: boolean; wholeWord?: boolean; regex?: boolean }
  /**
   * Selects positions [from, to) of the paragraph at `paragraph` (its index among the document's paragraphs); with `until`, from `from` there to the start of paragraph `until`;
   * with `toParagraph`, from `from` in `paragraph` to `to` in `toParagraph` (either way round: the caret ends at `to`).
   */
  | { kind: 'select'; paragraph: number; from: number; to: number; until?: number; toParagraph?: number }
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

export const NO_CHANGE: CommandResult = { edited: false, changed: new Set(), structural: false };

export function combine(a: CommandResult, b: CommandResult): CommandResult {
  if (!a.edited) return b;
  if (!b.edited) return a;
  return { edited: true, changed: new Set([...a.changed, ...b.changed]), structural: a.structural || b.structural, styles: a.styles || b.styles };
}
