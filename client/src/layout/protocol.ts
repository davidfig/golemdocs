// Messages between the page (renderer, input) and the layout worker (document model, fonts,
// layout, editing). The worker owns the document; the page sends input as commands and gets
// back encoded pages and selection geometry. Remote edits (multiplayer) will arrive in the
// worker the same way local ones do.

import type { Command } from '@word/editor';
import type { AnnotationKind, FormField } from '@word/pdf';
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
  /** A web page. */
  | { kind: 'html'; name: string; bytes: ArrayBuffer }
  /** An OpenDocument text file. */
  | { kind: 'odt'; name: string; bytes: ArrayBuffer }
  /** A plain-text file, edited one paragraph per line. */
  | { kind: 'txt'; name: string; bytes: ArrayBuffer }
  /** The app's own file (see ../formats/wdoc.ts): the whole document, opened in the format it was being edited as. */
  | { kind: 'wdoc'; name: string; bytes: ArrayBuffer }
  /** A new, empty document. */
  | { kind: 'blank'; name: string }
  /** Every font we ship, as a sample document. */
  | { kind: 'fonts' }
  /** What Golem Docs is: shown when there are no documents yet. */
  | { kind: 'welcome' };

/** An editor command as sent from the page: pages are referred to by id. */
export type WireCommand =
  | Exclude<Command, { kind: 'pointer' }>
  | (Omit<Extract<Command, { kind: 'pointer' }>, 'page'> & { page: number })
  | { kind: 'undo' }
  | { kind: 'redo' }
  /**
   * On a PDF shown as its own pages: mark the selected text, or put a note there (see
   * pdfAnnotator.ts). With an annotation selected, changes it instead.
   */
  | { kind: 'annotate'; annotation: AnnotationKind; color?: string | null; text?: string }
  /**
   * On a PDF shown as its own pages: its form fields are now these (filled in, moved, added or
   * removed). Edits with the same `merge` key as the last one undo together (typing in a field).
   */
  | { kind: 'setFields'; fields: WireField[]; merge?: string };

/** A form field as the page sees it: on a page (by id), its box in page coordinates (points, y down). */
export type WireField = FormField & { pageId: number; box: { x: number; y: number; width: number; height: number } };

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
  /** The whole document as a .wdoc; `lens` records a different format to edit it as next time. */
  | { type: 'save'; doc: number; request: number; lens?: Format }
  /** The document exported as a file of a format (the open document is left as it is). */
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
  /** The document's comments, in order, and where each one's text starts (page id and y), if laid out. */
  comments: { id: string; author: string; date?: string; text: string; page: number | null; y: number }[];
  /** Highlight over commented text: page id, x, y, width, height per rectangle. */
  commentRects: Float64Array;
  /** A PDF shown as its own pages: its form fields on the pages laid out so far. */
  fields?: WireField[];
}

export type FromWorker =
  /**
   * `format`: what the document is edited as (for a .wdoc, known only once it has been read).
   * `annotating`: a PDF shown as its own pages, which takes markup annotations.
   */
  | { type: 'opened'; doc: number; name: string; format: Format; annotating: boolean }
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
