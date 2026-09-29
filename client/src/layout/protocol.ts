// Messages between the page (renderer, input) and the layout worker (document model, fonts,
// layout, editing). The worker owns the document; the page sends input as commands and gets
// back encoded pages and selection geometry. Remote edits (multiplayer) will arrive in the
// worker the same way local ones do.

import type { Command } from '@word/editor';
import type { EncodedPage, FaceDescriptor } from '@word/layout';
import type { Format } from '../formats/convert.ts';
import type { FormatState } from '../ui/actions.ts';

export type DocumentSource =
  /** A .docx file's bytes (transferred to the worker). */
  | { kind: 'docx'; name: string; bytes: ArrayBuffer }
  /** A .docx file to fetch. */
  | { kind: 'docx-url'; name: string; url: string }
  /** A plain-text file to fetch and turn into a document (paragraphs at blank lines). */
  | { kind: 'text-url'; name: string; url: string }
  /** A PDF file: shown as its pages, read-only. */
  | { kind: 'pdf'; name: string; bytes: ArrayBuffer }
  /** A Markdown file, edited as a document that can hold what Markdown can. */
  | { kind: 'md'; name: string; bytes: ArrayBuffer }
  /** A plain-text file, edited one paragraph per line. */
  | { kind: 'txt'; name: string; bytes: ArrayBuffer }
  /** A new, empty document. */
  | { kind: 'blank'; name: string }
  /** Every font we ship, as a sample document. */
  | { kind: 'fonts' };

/** An editor command as sent from the page: pages are referred to by id. */
export type WireCommand =
  | Exclude<Command, { kind: 'pointer' }>
  | (Omit<Extract<Command, { kind: 'pointer' }>, 'page'> & { page: number })
  | { kind: 'undo' }
  | { kind: 'redo' };

/** A collaboration room to open the document in (see ../collab). */
export interface RoomOptions {
  name: string;
  /** Connected to the room server; transferred to the worker. */
  port: MessagePort;
  /** How this user appears to others. */
  user: string;
  color: number;
}

export type ToWorker =
  | { type: 'open'; doc: number; source: DocumentSource; room?: RoomOptions }
  /** Leaving the page: tell the room. */
  | { type: 'leave' }
  /** Bytes of an image part of the open document. */
  | { type: 'media'; doc: number; request: number; part: string }
  | { type: 'command'; doc: number; command: WireCommand }
  /** The document as a file in its own format. */
  | { type: 'save'; doc: number; request: number }
  /** The document as a file in another format (the open document is left as it is). */
  | { type: 'convert'; doc: number; request: number; to: Format };

export interface LayoutTimings {
  /** Reading and parsing the file. */
  read: number;
  /** Loading font metrics. */
  fonts: number;
  body: number;
  headers: number;
}

/**
 * Page updates. `pages` are pages the page thread hasn't seen; `order` is every page to show,
 * by id, in order; `drop` are ids it can dispose. Pages keep their id when re-layout keeps
 * them (even if they move), so an edit only sends the pages it changed.
 */
export interface LayoutUpdate {
  faces: FaceDescriptor[];
  pages: EncodedPage[];
  /** Header/footer content drawn over a page, replacing any it had. */
  overlays: { page: number; content: EncodedPage }[];
  order: Int32Array;
  drop: number[];
  /** The selection on these pages, so text and caret change in the same frame. */
  selection?: SelectionUpdate;
}

/** Caret and selection highlight, in page-relative points. */
export interface SelectionUpdate {
  caret: { page: number; x: number; y: number; height: number } | null;
  /** Highlight rectangles: page id, x, y, width, height per rectangle. */
  rects: Float64Array;
  focus: { page: number; x: number; y: number; height: number } | null;
  /** Scroll the focus into view (keyboard and edits, not clicks). */
  reveal: boolean;
  /** Selected text, for copy and cut. */
  text: string;
  /** Formatting at the caret or across the selection, for the toolbar. */
  format: FormatState;
  /** Whether Undo and Redo have anything to do. */
  canUndo: boolean;
  canRedo: boolean;
  /** Worker time from receiving the last command to sending this, ms (0 if not after a command). */
  workerMs: number;
  /** Other people's carets (in a collaboration room). */
  remote: { page: number; x: number; y: number; height: number; color: number; name: string }[];
}

export type FromWorker =
  | { type: 'opened'; doc: number; name: string }
  | ({ type: 'layout'; doc: number } & LayoutUpdate)
  /** The first full layout finished. */
  | { type: 'done'; doc: number; pages: number; timings: LayoutTimings }
  | ({ type: 'selection'; doc: number } & SelectionUpdate)
  | { type: 'error'; doc: number; message: string }
  /** Collaboration status: people in the room, and edits not yet confirmed by the server. */
  | { type: 'room'; doc: number; people: number; version: number; unconfirmed: number }
  | { type: 'media'; request: number; bytes: ArrayBuffer | null }
  | { type: 'saved'; request: number; bytes: ArrayBuffer | null; error?: string };

/** Font files, relative to the site root (the worker and the page both load from here). */
export const FONT_BASE = `${import.meta.env.BASE_URL}fonts/`;
