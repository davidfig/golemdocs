// Messages between the page (renderer, input) and the layout worker (document model, fonts,
// layout, editing). The worker owns the document; the page sends input as commands and gets
// back encoded pages and selection geometry. Remote edits (multiplayer) will arrive in the
// worker the same way local ones do.

import type { DocumentProperties, MathEquation } from '@golemdocs/docx';
import type { Command } from '@golemdocs/editor';
import type { Pointer, RoomRole } from '@golemdocs/ops';
import type { AnnotationKind, FormField } from '@golemdocs/pdf';
import type { EncodedPage, FaceDescriptor } from '@golemdocs/layout';
import type { Format } from '../formats/convert.ts';
import type { Shape } from '../formats/imageDraw.ts';
import type { Scene } from '../vector/model.ts';
import type { FormatState } from '../ui/actions.ts';
import type { FormatAction } from './formatting.ts';
import type { PickedStyle } from './pdfAnnotator.ts';

export type DocumentSource =
  /** A .docx file's bytes (transferred to the worker). */
  | { kind: 'docx'; name: string; bytes: ArrayBuffer }
  /** A Word 97-2003 (.doc) file, read into the same model. */
  | { kind: 'doc'; name: string; bytes: ArrayBuffer }
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
  /** A picture (PNG, JPEG or WebP), opened as a page showing it. */
  | { kind: 'image'; name: string; bytes: ArrayBuffer }
  /** A vector drawing (SVG, or gzip-compressed .svgz), opened as a page showing it. */
  | { kind: 'svg'; name: string; bytes: ArrayBuffer }
  /** LaTeX source. */
  | { kind: 'tex'; name: string; bytes: ArrayBuffer }
  /** AsciiDoc source. */
  | { kind: 'adoc'; name: string; bytes: ArrayBuffer }
  /** reStructuredText source. */
  | { kind: 'rst'; name: string; bytes: ArrayBuffer }
  /** An email message. */
  | { kind: 'eml'; name: string; bytes: ArrayBuffer }
  /** A Jupyter notebook. */
  | { kind: 'ipynb'; name: string; bytes: ArrayBuffer }
  /** MediaWiki markup. */
  | { kind: 'mediawiki'; name: string; bytes: ArrayBuffer }
  /** Textile markup. */
  | { kind: 'textile'; name: string; bytes: ArrayBuffer }
  /** Typst markup. */
  | { kind: 'typst'; name: string; bytes: ArrayBuffer }
  /** DocBook XML. */
  | { kind: 'docbook'; name: string; bytes: ArrayBuffer }
  /** A JATS (journal article) XML file. */
  | { kind: 'jats'; name: string; bytes: ArrayBuffer }
  /** A FictionBook e-book. */
  | { kind: 'fb2'; name: string; bytes: ArrayBuffer }
  /** An OPML outline. */
  | { kind: 'opml'; name: string; bytes: ArrayBuffer }
  /** Org mode source. */
  | { kind: 'org'; name: string; bytes: ArrayBuffer }
  /** Comma-, semicolon- or pipe-delimited text, opened as a table. */
  | { kind: 'csv'; name: string; bytes: ArrayBuffer }
  /** Tab-delimited text, opened as a table. */
  | { kind: 'tsv'; name: string; bytes: ArrayBuffer }
  /** An e-book. */
  | { kind: 'epub'; name: string; bytes: ArrayBuffer }
  /** A web page saved as one MIME message. */
  | { kind: 'mhtml'; name: string; bytes: ArrayBuffer }
  /** A Rich Text Format file. */
  | { kind: 'rtf'; name: string; bytes: ArrayBuffer }
  /** A plain-text file, edited one paragraph per line. */
  | { kind: 'txt'; name: string; bytes: ArrayBuffer }
  /** The app's own file (see ../formats/wdoc.ts): the whole document, opened in the format it was being edited as. */
  | { kind: 'wdoc'; name: string; bytes: ArrayBuffer }
  /** A new, empty document. */
  | { kind: 'blank'; name: string }
  /** Every font we ship, as a sample document. */
  | { kind: 'fonts' }
  /** What Golem Docs is: shown when there are no documents yet. */
  | { kind: 'welcome' }
  /** The privacy policy or the terms of service, written as documents like the welcome one. */
  | { kind: 'legal'; page: LegalPage }
  /** What's New: the repository's CHANGELOG.md, opened as a document. */
  | { kind: 'changelog' };

/** The built-in legal documents, at `/privacy` and `/terms`. */
export type LegalPage = 'privacy' | 'terms';

/** An editor command as sent from the page: pages are referred to by id. */
export type WireCommand =
  | Exclude<Command, { kind: 'pointer' | 'formatText' | 'formatParagraphs' | 'changeCase' }>
  | (Omit<Extract<Command, { kind: 'pointer' }>, 'page'> & { page: number })
  | { kind: 'undo' }
  | { kind: 'redo' }
  /** Formatting from the menus and toolbars (see formatting.ts). */
  | { kind: 'format'; action: FormatAction }
  /**
   * Spelling and Grammar: selects the next thing wrong, from the start of the document, the start
   * or the end of the selection, and reports it (see `SelectionUpdate.spell`).
   */
  | { kind: 'spellNext'; from: 'documentStart' | 'selectionStart' | 'selectionEnd'; grammar: boolean }
  /** Words to accept as spelled correctly (the user's dictionary, or ones ignored), and grammar rules to ignore. */
  | { kind: 'spellWords'; words?: string[]; rules?: string[] }
  /** Check-as-you-type: what to underline in the document, and the user's dictionary words to accept. */
  | { kind: 'spellCheck'; spelling: boolean; grammar: boolean; words?: string[] }
  /** Whether typed Markdown shortcuts ("# ", "- ", "**bold**") turn into formatting (see autoformat.ts). */
  | { kind: 'autoFormat'; on: boolean }
  /** Whether the paragraph the caret is in shows its Markdown source, in Markdown documents (see livePreview.ts). */
  | { kind: 'livePreview'; on: boolean }
  /** Right click at a point of a page: selects the mistake there and reports it (see `SelectionUpdate.spell`, `menu`). */
  | { kind: 'spellAt'; page: number; x: number; y: number }
  /** Count the words, characters, paragraphs, lines and pages of the document (or of the selection): the answer is `SelectionUpdate.stats`. */
  | { kind: 'countWords'; /** Count the whole document even if there is a selection. */ whole?: boolean; /** The status bar is asking: the answer comes back as `footerStats`, not `stats`. */ footer?: boolean }
  /** Paste formatted text from the clipboard's HTML (`text` is its plain text, used if the HTML can't be read). */
  | { kind: 'pasteHtml'; html: string; text: string }
  /** Ask for the document's properties (title, author…): the answer is `SelectionUpdate.docProperties`. */
  | { kind: 'getProperties' }
  /** The pointer was released: with the Format Painter picked up, paint the selection (if there is one). */
  | { kind: 'applyPainter' }
  /**
   * On a PDF shown as its own pages: mark the selected text, or put a note there (see
   * pdfAnnotator.ts). With an annotation selected, changes it instead.
   */
  | { kind: 'annotate'; annotation: AnnotationKind; color?: string | null; text?: string }
  /**
   * On a PDF shown as its own pages: its form fields are now these (filled in, moved, added or
   * removed). Edits with the same `merge` key as the last one undo together (typing in a field).
   */
  | { kind: 'setFields'; fields: WireField[]; merge?: string }
  /** On a PDF in Edit PDF mode: pick the text at a point of a page (by id) to edit it in place. */
  | { kind: 'pdfPick'; page: number; x: number; y: number }
  /** The picked text now reads this (typing in the editor over it). */
  | { kind: 'pdfText'; text: string }
  /** Done editing the picked text. */
  | { kind: 'pdfPutDown' }
  /** The picked text is shown in another look (whole block): a family (one of the app's, or Helvetica, Times or Courier), style, size and color (#rrggbb). */
  | { kind: 'pdfStyle'; font?: string; bold?: boolean; italic?: boolean; size?: number; color?: string }
  /** The picked text is moved this far (points, page coordinates: x right, y down). */
  | { kind: 'pdfMoveText'; dx: number; dy: number }
  /** The selected object is now in this box, on its page (page coordinates). */
  | { kind: 'pdfMove'; box: WireBox }
  /** The selected shape's look (colors #rrggbb, null for none). */
  | { kind: 'pdfShape'; stroke?: string | null; fill?: string | null; width?: number }
  /** Adds a shape to a page (by id), in this box (page coordinates), and selects it. A whiteout is a white rectangle. */
  | { kind: 'pdfAddShape'; page: number; shape: 'rect' | 'ellipse' | 'line' | 'check' | 'cross' | 'whiteout' | 'redact'; box: WireBox; flip?: boolean }
  /** Adds a picture (a PNG or JPEG file, base64) to a page, in this box, and selects it. */
  | { kind: 'pdfAddImage'; page: number; box: WireBox; data: string }
  /** Adds a text box with its top left at a point of a page, and picks it to type in. */
  | { kind: 'pdfAddText'; page: number; x: number; y: number; /** What it says to begin with (a date, say). */ text?: string }
  /** Changes the pages of the PDF: the page (by id) is deleted, turned, moved (a step, or to index `to` of the new order), copied, or a blank one is put after it. */
  | { kind: 'pdfPageOp'; page: number; op: 'delete' | 'rotateLeft' | 'rotateRight' | 'moveUp' | 'moveDown' | 'duplicate' | 'insert' }
  | { kind: 'pdfPageOp'; page: number; op: 'move'; to: number };

/** The commands only a PDF shown as its own pages takes (not the editor). */
export type PdfWireCommand = Extract<WireCommand, { kind: 'annotate' | 'setFields' | 'pdfPick' | 'pdfText' | 'pdfPutDown' | 'pdfStyle' | 'pdfMoveText' | 'pdfMove' | 'pdfShape' | 'pdfAddShape' | 'pdfAddImage' | 'pdfAddText' | 'pdfPageOp' }>;

const PDF_COMMANDS: ReadonlySet<string> = new Set(['annotate', 'setFields', 'pdfPick', 'pdfText', 'pdfPutDown', 'pdfStyle', 'pdfMoveText', 'pdfMove', 'pdfShape', 'pdfAddShape', 'pdfAddImage', 'pdfAddText', 'pdfPageOp']);

export const isPdfCommand = (command: WireCommand): command is PdfWireCommand => PDF_COMMANDS.has(command.kind);

/** A box on a page: points from its top left, y down. */
export interface WireBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A picture, shape or drawing selected on a PDF's page, as the page sees it. */
export interface WirePickedObject {
  pageId: number;
  id: string;
  kind: 'image' | 'path' | 'form' | 'shape' | 'picture' | 'redact';
  box: WireBox;
  /** An added shape's look (colors #rrggbb). */
  shape?: { shape: 'rect' | 'ellipse' | 'line' | 'check' | 'cross'; stroke: string | null; fill: string | null; width: number };
}

/** Text of a PDF's page being edited in place, as the page sees it: on a page (by id), boxes in page coordinates (points, y down). */
export interface WirePickedText {
  pageId: number;
  id: string;
  /** Added to the page (a text box), not the file's own text: it can be deleted. */
  added: boolean;
  text: string;
  box: { x: number; y: number; width: number; height: number };
  /** Where the first line's baseline is, on the page. */
  baseline: number;
  style: PickedStyle;
}

/** A form field as the page sees it: on a page (by id), its box in page coordinates (points, y down). */
export type WireField = FormField & { pageId: number; box: { x: number; y: number; width: number; height: number } };

/** A collaboration room to open the document in (see ../collab). */
export interface RoomOptions {
  /** The cloud document whose multiplayer room this is. */
  docId: string;
  /** How this user appears to others. */
  user: string;
  color: number;
}

/** Where a document stands in the multiplayer server's room. */
export interface RoomState {
  /** solo: saved to the cloud from here. shared: the server saves. offline: connection lost for good. */
  mode: 'solo' | 'shared' | 'offline';
  role: RoomRole;
  /** Everyone in the room, including this user. */
  people: { name: string; picture: string | null; color: number; /** This user. */ me: boolean }[];
  /** Edits the server hasn't confirmed (shared only). */
  unconfirmed: number;
  /** A document edited by one person at a time (a PDF, a picture): who holds it (`mine`: this account, on this device or another), or null. */
  holder: { name: string; mine: boolean } | null;
  /** Someone else holds it: this person looks, and sees it again each time it is saved. */
  watching: boolean;
  /** It was saved since it was opened here: nothing may be changed until the newer one is open. */
  catchingUp: boolean;
}

/**
 * Messages from the page to the worker. The worker handles them in the order they were sent: one
 * for a document sent straight after asking to open it finds that document (still being set up,
 * perhaps), never the one before. Messages for an older document are ignored.
 */
export type ToWorker =
  /** Flow view: lay pages out this many points wide, with slim margins (null: the document's own page sizes), and lay the open document out again. */
  | { type: 'reflow'; width: number | null }
  /** Draw formatting marks (¶, dots for spaces, tab arrows) on pages laid out from now on, and lay the open document out again. */
  | { type: 'marks'; on: boolean }
  /** The page's language, so errors and default names the worker makes are in it. Sent before any `open`. */
  | { type: 'locale'; locale: string }
  /** `keepRoom`: the same picture or drawing, changed, opened in place of the open one: it keeps that one's room. */
  | { type: 'open'; doc: number; source: DocumentSource; room?: RoomOptions; keepRoom?: boolean; /** With `keepRoom`: the saved version this is. */ version?: number }
  /** Where this user's mouse is (null: it left the document), for the other people in the room. */
  | { type: 'pointer'; doc: number; pointer: Pointer | null }
  /** The open document has just been uploaded to the cloud: join its multiplayer room now. */
  | { type: 'joinRoom'; doc: number; room: RoomOptions }
  /** Watching a document someone else holds: ask to hold it. */
  | { type: 'takeOver'; doc: number }
  /** Holding a document someone takes over: what there was is saved, so let it go. */
  | { type: 'roomReleased'; doc: number }
  /** Leaving the page: tell the room. */
  | { type: 'leave' }
  /** The open document is closed and none replaces it (the page now shows something the worker does not hold: a plain text file). */
  | { type: 'close' }
  /** Bytes of an image part of the open document. */
  | { type: 'media'; doc: number; request: number; part: string }
  /** The address of the link under a page point (for the hover tip). */
  | { type: 'linkAt'; doc: number; request: number; page: number; x: number; y: number }
  | { type: 'command'; doc: number; command: WireCommand }
  /** Puts a picture in the document at the caret (its bytes go into the document; its size is in EMUs). */
  | { type: 'insertImage'; doc: number; bytes: ArrayBuffer; ext: string; width: number; height: number; description?: string }
  /** A vector drawing at the caret, or (`replace`: the part of the SVG it replaces) in place of the one it is an edited version of; sizes in EMUs. */
  /** A picture's shapes are now these (the person drew, erased or moved something); or step back over (undo) or forward again (redo) over the person's own changes to them. */
  | { type: 'shapes'; doc: number; shapes: Shape[]; base?: Shape[] }
  | { type: 'shapesStep'; doc: number; action: 'undo' | 'redo' }
  /** A drawing edited together is now this (the person changed it); or step back over, or forward again over, the person's own changes to it. */
  | { type: 'vectorScene'; doc: number; scene: Scene; base?: Scene }
  | { type: 'vectorStep'; doc: number; action: 'undo' | 'redo' }
  | { type: 'putDrawing'; doc: number; svg: string; png: ArrayBuffer; width: number; height: number; description?: string; replace?: string }
  /** The whole document as a .wdoc; `lens` records a different format to edit it as next time. */
  | { type: 'save'; doc: number; request: number; lens?: Format }
  /** The document exported as a file of a format (the open document is left as it is). */
  | { type: 'convert'; doc: number; request: number; to: Format }
  /** The open picture's own file, without the shapes drawn over it. */
  | { type: 'pictureBase'; doc: number; request: number }
  /** The assistant uses a tool on the open document (see agentTools.ts): `args` is the JSON the model wrote. */
  | { type: 'agent'; doc: number; request: number; name: string; args: string }
  /** The stored document an embed asked for (`embed`), or none; its bytes are the file as stored. */
  | { type: 'embedFile'; request: number; file: { name: string; bytes: ArrayBuffer } | null }
  /** What is wrong in each of some lines of a plain text file (no document is involved): `sample` is the beginning of the file, which says its language. `at` asks instead for the problem under an offset of the line `texts[at.index]`. */
  | { type: 'spellText'; request: number; texts: string[]; sample: string; spelling: boolean; grammar: boolean; at?: { index: number; offset: number } };

/** A mistake in a line of text: where it is, and whether it is spelling (0) or grammar (1). */
export interface TextMark {
  start: number;
  end: number;
  kind: 0 | 1;
}

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
  /** Set once after a `spellNext`: what is wrong at the selection, or null when nothing more is. */
  spell?: { issue: SpellIssue | null; /** After a `spellAt`: for the right-click menu, not the dialog. */ menu?: boolean };
  /** The squiggles under what is wrong (check-as-you-type): page id, x, y, width, height, kind (0 spelling, 1 grammar) per mark. */
  spellMarks?: Float64Array;
  /** Set once after `getProperties`. */
  docProperties?: DocumentProperties;
  /** Set once after `countWords`: the counts, or null when this document has none to give (a PDF shown as pages). */
  stats?: WordStats | null;
  /** Set once after a `countWords` the status bar asked for. */
  footerStats?: WordStats | null;
  /** The page size and margins of the section the selection is in, for the Page Setup dialog (twips). */
  page?: { width: number; height: number; landscape: boolean; top: number; bottom: number; left: number; right: number; gutter: number; header: number; footer: number };
  /** The columns of the section the selection is in, for the Columns dialog (spacing and width in twips). */
  columns?: { count: number; space: number; sep: boolean; width: number };
  /** The selection is in a table cell (the Table menu works on it). */
  inTable?: boolean;
  /** The link the selection is in (or starts in), for Insert Hyperlink and Ctrl+click. */
  link?: { url: string; text: string } | null;
  /** The equation the selection is (exactly), for Insert Equation to change. */
  math?: MathEquation | null;
  /** The Format Painter has picked up formatting and is waiting for a selection. */
  painting?: boolean;
  /** Set once after a Find (whether it found a match) or Replace All (how many it replaced). */
  search?: { found?: boolean; replaced?: number };
  /** Whether Undo and Redo have anything to do. */
  canUndo: boolean;
  canRedo: boolean;
  /** Worker time from receiving the last command to sending this, ms (0 if not after a command). */
  workerMs: number;
  /** Other people's carets (in a collaboration room). */
  remote: { page: number; x: number; y: number; height: number; color: number; name: string }[];
  /** What other people have selected: rectangles per person, as (page, x, y, width, height) runs. */
  remoteRects: { color: number; rects: number[] }[];
  /** The document's comments, in order, and where each one's text starts (page id and y), if laid out. */
  comments: { id: string; author: string; initials?: string; date?: string; parentId?: string; resolved?: boolean; text: string; page: number | null; y: number }[];
  /** The thread (its first comment's id) the caret is in. */
  activeComment: string | null;
  /** Highlight over commented text: page id, x, y, width, height per rectangle. */
  commentRects: Float64Array;
  /** A PDF shown as its own pages: its form fields on the pages laid out so far. */
  fields?: WireField[];
  /** A PDF shown as its own pages: the text picked to edit in place (null: none). */
  pdfText?: WirePickedText | null;
  /** A PDF shown as its own pages: the picture or shape selected (null: none). */
  pdfObject?: WirePickedObject | null;
  /** Set once when a redaction couldn't take out all it covers (a picture only partly under it stays whole). */
  pdfNotice?: 'partialRedaction';
  /** Set once for fonts in PDF edits that the app has no equivalent of, so different ones were used. */
  pdfFontNotice?: string[];
}

export type FromWorker =
  /**
   * `format`: what the document is edited as (for a .wdoc, known only once it has been read).
   * `annotating`: a PDF shown as its own pages, which takes markup annotations. `outdated`: those
   * pages are the original's, and the text has been edited since (as Word, Markdown...).
   */
  | { type: 'opened'; doc: number; name: string; format: Format; annotating: boolean; outdated: boolean }
  | ({ type: 'layout'; doc: number } & LayoutUpdate)
  /** The first full layout finished. */
  | { type: 'done'; doc: number; pages: number; timings: LayoutTimings }
  | ({ type: 'selection'; doc: number } & SelectionUpdate)
  | { type: 'error'; doc: number; message: string }
  /** Something to tell the person that isn't a failure to open (a picture that could not be shared, say). */
  | { type: 'notice'; doc: number; message: string }
  /** A picture's shapes (opening, or changed by others or by undo), its size in pixels, and whether its shapes can be undone or redone. */
  | { type: 'shapes'; doc: number; shapes: Shape[]; width: number; height: number; canUndo: boolean; canRedo: boolean }
  /** A drawing being edited together: as it stands now (null: it has not changed, only what can be undone) after others' changes or an undo, and whether the person's own changes can be undone or redone. */
  | { type: 'vectorScene'; doc: number; scene: Scene | null; canUndo: boolean; canRedo: boolean }
  /** Collaboration status: people in the room, and edits not yet confirmed by the server. */
  /** The multiplayer room changed: who is in it, what this user may do, who saves. */
  | ({ type: 'roomState'; doc: number } & RoomState)
  | { type: 'roomReplace'; doc: number }
  /** A document edited one person at a time: the person holding it saved it (open it again, watching); someone takes over (save
   * what there is, then answer `roomReleased`); someone started watching (save now). */
  | { type: 'roomSaved'; doc: number; updatedAt: number }
  | { type: 'roomRelease'; doc: number }
  | { type: 'roomFlush'; doc: number }
  /** There is no room for the document after all (it could not be joined, or was lost while this user was alone in it): it is edited and saved as if it had none. */
  | { type: 'roomGone'; doc: number }
  /** Where other people's mouse pointers are (page positions in display order, points). */
  | { type: 'pointers'; doc: number; pointers: { page: number; x: number; y: number; color: number; name: string; picture: string | null }[] }
  /** Someone else's edit changed the document (it needs saving here too). */
  | { type: 'remoteEdit'; doc: number }
  | { type: 'media'; request: number; bytes: ArrayBuffer | null }
  /** A Markdown document being opened embeds a picture or note (`![[title]]`): the stored document of that title, as `embedFile`. */
  | { type: 'embed'; request: number; title: string }
  | { type: 'linkAt'; request: number; url: string | null; checkbox: boolean }
  | { type: 'saved'; request: number; bytes: ArrayBuffer | null; error?: string }
  /** What an assistant tool did or found. */
  /** `images` are pictures the tool fetched for the model to look at (data: URIs). */
  | { type: 'agentResult'; request: number; result: string; images?: string[] }
  /** The answer to a `spellText`: the marks of every line (a language whose dictionary is still loading has none yet, and `loading` says so), or the problem at `at`. */
  | { type: 'spellText'; request: number; marks: TextMark[][]; issue: SpellIssue | null; loading: boolean };

/** What Tools ▸ Word Count shows. `selection`: they are for the selected text, not the document. */
export interface WordStats {
  pages: number;
  words: number;
  charactersWithSpaces: number;
  charactersWithoutSpaces: number;
  paragraphs: number;
  lines: number;
  selection: boolean;
  /** A CSV or TSV document's size, for the status bar. */
  table?: { rows: number; columns: number };
}

/** A problem the Spelling and Grammar check found, with the sentence around it. */
export interface SpellIssue {
  kind: 'spelling' | 'grammar';
  /** The sentence before the problem, the problem, and the sentence after it. */
  before: string;
  text: string;
  after: string;
  /** "Not in Dictionary", or what the grammar rule says. */
  message: string;
  suggestions: string[];
  /** Grammar only, to ignore the rule. */
  rule?: string;
}

/** Where the spelling dictionaries are served from. */
export const DICTIONARY_BASE = `${(import.meta.env?.BASE_URL ?? "/")}dictionaries/`;

/** Font files, relative to the site root (the worker and the page both load from here). */
export const FONT_BASE = `${(import.meta.env?.BASE_URL ?? "/")}fonts/`;
