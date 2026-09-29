// Operations: the edits a document goes through, as plain JSON.
//
// Paragraphs are addressed by id (w14:paraId, kept in the file) and positions by model offset
// (see @word/docx edit/text.ts), never by object references or layout, so an operation means
// the same thing on every client, on a server, and after a save and reload. Every operation
// applied yields its inverse (for undo and for rebasing) and a position map (to move
// selections, pending operations and undo history through it).

import type { Attributes, Block, Comment, Inline, ParagraphProperties, RunContent } from '@word/docx';

/** A position: a paragraph (by id) and a model offset in it. */
export interface Pos {
  paragraph: string;
  offset: number;
}

export type Operation =
  /** Text formatted like the text before it (see @word/docx insertText). */
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
  /** Inserts blocks right after a paragraph. */
  | { type: 'insertBlocks'; after: string; blocks: Block[] }
  /** Removes particular blocks (by blockKey) from the container of paragraph `after`. */
  | { type: 'removeBlocks'; after: string; keys: string[] }
  | { type: 'setParagraphProperties'; paragraph: string; properties: ParagraphProperties }
  /** Adds, replaces (by id) or, with `comment` null, removes a comment's text and author. Its range is markers in the text. */
  | { type: 'setComment'; id: string; comment: Comment | null };

/** Operations applied together: one edit, one undo step, one unit of collaboration. */
export interface Transaction {
  /** Unique across clients (client id + counter). */
  id: string;
  client: string;
  ops: Operation[];
}

/** An offset beyond any paragraph's end (for deletes "to the end"). */
export const END = Number.MAX_SAFE_INTEGER;
