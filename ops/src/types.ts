// SPDX-License-Identifier: MIT
// Operations: the edits a document goes through, as plain JSON.
//
// Paragraphs are addressed by id (w14:paraId, kept in the file) and positions by model offset
// (see @golemdocs/docx edit/text.ts), never by object references or layout, so an operation means
// the same thing on every client, on a server, and after a save and reload. Every operation
// applied yields its inverse (for undo and for rebasing) and a position map (to move
// selections, pending operations and undo history through it).

import type { AbstractNumbering, Attributes, Block, Comment, Inline, NumberingInstance, DocumentProperties, ParagraphProperties, RunContent, RunProperties, SectionProperties, Style, TableCell, TableCellProperties, TableRow } from '@golemdocs/docx';

/** Changes to run formatting, per property: a value to set, or null to remove it. */
export type RunFormat = { [K in keyof RunProperties]?: RunProperties[K] | null };

/** A position: a paragraph (by id) and a model offset in it. */
export interface Pos {
  paragraph: string;
  offset: number;
}

export type Operation =
  /** Text formatted like the text before it (see @golemdocs/docx insertText). */
  | { type: 'insertText'; paragraph: string; offset: number; text: string }
  /** One non-text run item (tab, line break), formatted like text there. */
  | { type: 'insertItem'; paragraph: string; offset: number; item: RunContent }
  /** Inline content as is (runs with their formatting, hyperlinks...). */
  | { type: 'insertContent'; paragraph: string; offset: number; content: Inline[] }
  /** Removes positions [from, to); `to` past the end means to the end. */
  | { type: 'delete'; paragraph: string; from: number; to: number }
  /** Splits a paragraph; the part after `offset` becomes a new paragraph `id` after it. */
  | { type: 'split'; paragraph: string; offset: number; id: string; properties: ParagraphProperties; attrs?: Attributes }
  /** Appends the content of the paragraph after `paragraph` (`next`) to it and removes `next`. */
  | { type: 'merge'; paragraph: string; next: string }
  /** Removes the blocks between two paragraphs of one container (paragraphs, tables...). */
  | { type: 'removeBetween'; after: string; before: string }
  /** Inserts blocks right after a paragraph, or right before it with `before`. */
  | { type: 'insertBlocks'; after: string; blocks: Block[]; before?: boolean }
  /** Removes particular blocks (by blockKey) that follow paragraph `after` in its container (or, with `before`, precede it). */
  | { type: 'removeBlocks'; after: string; keys: string[]; before?: boolean }
  /** Adds a row below (`after`) or above the row that holds `paragraph`. Its paragraphs need ids nothing else has. */
  | { type: 'insertRow'; paragraph: string; after: boolean; row: TableRow }
  /** Removes the row that holds `paragraph`. Does nothing to a table's only row (remove the table instead). */
  | { type: 'removeRow'; paragraph: string }
  /** Adds a cell to the right of (`after`) or left of the cell that holds `paragraph`. */
  | { type: 'insertCell'; paragraph: string; after: boolean; cell: TableCell }
  /** Removes the cell that holds `paragraph`. Does nothing to a row's only cell. */
  | { type: 'removeCell'; paragraph: string }
  /** Sets the column widths of the table that holds `paragraph`, twips. */
  | { type: 'setTableGrid'; paragraph: string; grid: number[] }
  /** Replaces the document's properties (title, author... of File ▸ Properties). */
  | { type: 'setDocumentProperties'; properties: DocumentProperties }
  /** Replaces the document's last section's properties (the earlier sections' are in their last paragraph's properties). */
  | { type: 'setDocumentSection'; properties: SectionProperties }
  /** Replaces the properties (width, span, shading...) of the cell that holds `paragraph`. */
  | { type: 'setCellProperties'; paragraph: string; properties: TableCellProperties }
  /** Changes the formatting of the text in positions [from, to); `to` past the end means to the end. */
  | { type: 'formatText'; paragraph: string; from: number; to: number; format: RunFormat }
  | { type: 'setParagraphProperties'; paragraph: string; properties: ParagraphProperties }
  /** Adds, replaces (by id) or, with `style` null, removes a style of the style sheet. */
  | { type: 'setStyle'; id: string; style: Style | null }
  /**
   * Adds, replaces or, with `list` null, removes a list definition: numbering instance `id`
   * and the abstract numbering it uses (which no other instance may share).
   */
  | { type: 'setList'; id: number; list: { instance: NumberingInstance; abstract: AbstractNumbering } | null }
  /** Adds, replaces (by id) or, with `comment` null, removes a comment's text and author. Its range is markers in the text. */
  | { type: 'setComment'; id: string; comment: Comment | null };

/** Every operation's `type` (a Record, so adding an operation without listing it here doesn't compile). */
const OPERATION_TYPES: Record<Operation['type'], true> = {
  insertText: true,
  insertItem: true,
  insertContent: true,
  delete: true,
  split: true,
  merge: true,
  removeBetween: true,
  insertBlocks: true,
  removeBlocks: true,
  insertRow: true,
  removeRow: true,
  insertCell: true,
  removeCell: true,
  setTableGrid: true,
  setDocumentProperties: true,
  setDocumentSection: true,
  setCellProperties: true,
  formatText: true,
  setParagraphProperties: true,
  setStyle: true,
  setList: true,
  setComment: true,
};

/** Whether something received (from another client, say) is at least an object naming an operation there is. */
export function isOperation(op: unknown): op is Operation {
  return typeof op === 'object' && op !== null && Object.hasOwn(OPERATION_TYPES, (op as { type?: unknown }).type as string);
}

/** Operations applied together: one edit, one undo step, one unit of collaboration. */
export interface Transaction {
  /** Unique across clients (client id + counter). */
  id: string;
  client: string;
  ops: Operation[];
}

/** An offset beyond any paragraph's end (for deletes "to the end"). */
export const END = Number.MAX_SAFE_INTEGER;
