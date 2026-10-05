// The assistant's tools that act on the app rather than the document's text: the person's files,
// their other documents, what the open document is (its name, its format, its view) and picture
// edits. The rest run in the layout worker (../layout/agentTools.ts). The app's state comes through
// the host, so these use the same functions the menus do.

import type { SearchOptions } from '@golemdocs/editor/pattern';
import { describeDrawing, editDrawing } from './drawingTools.ts';
import { SMOOTHING_LEVELS, setLockGuides, setPenPressure, setPencilSmoothing, setReturnToSelect, setSelectAfterPencil, setShowGuides } from '../ui/drawingOptions.ts';
import type { DrawingEditor } from './drawingTools.ts';
import type { ImageEdit } from '../formats/imageEdit.ts';
import type { Background, Shape } from '../formats/imageDraw.ts';
import { ANCHORS } from '../formats/imagePixels.ts';
import { LAYER_OPS, describeLayers, layerOp } from './pictureLayerTools.ts';
import { FORMAT_LIST, isFormat } from '../formats/convert.ts';
import { sniffImage } from '../formats/images.ts';
import { MAX_SIDE } from '../formats/imagePixels.ts';
import { displayDocumentName } from '../documentName.ts';
import type { LibraryEntry } from '../sync.ts';
import type { Action, ImageOp } from '../ui/actions.ts';
import { FORMATS } from '../ui/formats.ts';
import { NEW_KINDS } from '../ui/newKinds.ts';
import type { DocumentKind } from '../ui/actions.ts';
import type { ToolResult } from './conversation.ts';
import { fileTools, type FileToolsHost } from './fileTools.ts';
import type { OtherDocuments } from './libraryDocs.ts';
import { MAX_COPY } from './otherDocs.ts';

/** The large-text editor, when a big text file is open in it. Lines are numbered from 1; each answers in words for the model ("Error:" says nothing was done). */
export interface TextEditorTools {
  describe(): string;
  read(start: number, count: number): string;
  findAll(options: SearchOptions): Promise<string>;
  replaceFile(options: SearchOptions, replacement: string): Promise<string>;
  editLines(first: number, last: number, text: string): string;
  insertLines(after: number, text: string): string;
  deleteLines(first: number, last: number): string;
  undoStep(): string;
  redoStep(): string;
}

export interface AppToolsHost {
  /** The large-text editor if a big text file is open in it (the paragraph tools do not apply to it), else null. */
  textEditor(): TextEditorTools | null;
  /** The open document: a new object each time one is opened. */
  current(): object;
  documentName(): string;
  documentKind(): DocumentKind;
  /** Runs one of the layout worker's tools on the open document. */
  agent(name: string, args: string): Promise<ToolResult>;
  /** The person's documents and folders, for the file tools. */
  files: FileToolsHost;
  /** Their other documents (this browser's, the account's and shared ones), to read and search. */
  otherDocuments: OtherDocuments;
  renamable(): boolean;
  /** File › Rename: the name kept, or null if it isn't one. */
  renameDocument(name: string): string | null;
  /** File › Convert To. */
  convertTo(kind: DocumentKind): Promise<void>;
  /** Whether the open document is being edited with other people (it then can't change format). */
  inRoom(): boolean;
  /** Opens a document of the library, resolving once it has opened. */
  openEntry(entry: LibraryEntry): Promise<void>;
  /** File › New (in `folderId`), resolving once the new document has opened. */
  newDocument(folderId: string | null, docKind?: DocumentKind): Promise<void>;
  /** Does what a menu or toolbar does. */
  perform(action: Action): Promise<void> | void;
  view(): { statusBar: boolean; ruler: boolean; formattingMarks: boolean };
  isPicture(): boolean;
  /** The open picture as a file of its type. */
  pictureBytes(): Promise<Uint8Array>;
  /** Changes the open picture (one undoable step). */
  changePicture(edit: ImageEdit): Promise<void>;
  /** The open vector drawing's editor (loaded if need be), or null when the open document is not a drawing (or a drawing in its text being edited). */
  drawing(): Promise<DrawingEditor | null>;
  /** The drawings in the text of the open document, in reading order. */
  textDrawings(): { page: number; width: number; height: number; embed?: string }[];
  /** Starts editing drawing `index` of `textDrawings` in place; the reason it can't, or null. */
  openTextDrawing(index: number): Promise<string | null>;
  /** Puts the drawing being edited in place back in the text; the reason it can't, or null. */
  closeTextDrawing(): Promise<string | null>;
  /** A new blank drawing in the text, open for drawing; the reason it can't be, or null. */
  insertTextDrawing(size: { width?: number; height?: number }): Promise<string | null>;
  /** Who is editing the open document. */
  collaboration(): Collaboration;
  /** The shapes drawn over the open picture (its layers), and a change of them (resolving once it has taken effect). */
  pictureShapes(): readonly Shape[];
  setPictureShapes(shapes: Shape[]): Promise<void>;
  /** Why the open document can't be changed: someone else holds it (a PDF or a picture is edited by one person at a time), or null. */
  watching(): string | null;
  /** Asks to hold the open document someone else is editing; false if nobody else holds it. */
  takeOver(): boolean;
}

/** Who is editing the open document. */
export interface Collaboration {
  /** Others are here with the person. */
  shared: boolean;
  /** Everyone's names when known (yours marked), else how many. */
  people: string[];
  count: number;
  /** A document edited by one person at a time (a PDF, a picture): who holds it (`mine`: the person, here or on another device), or null for one everyone edits at once. */
  holder: { name: string; mine: boolean; here: boolean } | null;
}

/** Tools that don't read or change the open document (the person's other documents, the app's settings); every other one is refused once a different document is open. File tools are left alone too. */
const ELSEWHERE_TOOLS = new Set(['search_documents', 'read_other_document', 'open_file', 'new_document', 'download_all', 'set_drawing_options']);
/** Tools that open another document on purpose: the request goes on with that one. */
const OPENING_TOOLS = new Set(['convert_document', 'open_file', 'new_document']);

const formatLabel = (kind: string): string => (isFormat(kind) ? `${FORMATS[kind].label} (${FORMATS[kind].extensions[0]})` : kind);
const optionalFlag = (args: Record<string, unknown>, key: string): boolean | undefined => {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Error(`\`${key}\` must be true or false.`);
  return v;
};
const wholeNumber = (args: Record<string, unknown>, key: string, min: number, max: number): number => {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`\`${key}\` must be a whole number from ${min} to ${max}.`);
  return v;
};

/** A whole number argument that may be left out. */
const searchOptions = (args: Record<string, unknown>): SearchOptions => {
  if (typeof args.text !== 'string') throw new Error('`text` must be text: what to find.');
  return { text: args.text, caseSensitive: optionalFlag(args, 'match_case') ?? false, wholeWord: optionalFlag(args, 'whole_word') ?? false, regex: optionalFlag(args, 'regex') ?? false };
};

const optionalNumber = (args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number => {
  if (args[key] === undefined) return fallback;
  return wholeNumber(args, key, min, max);
};

const IMAGE_OPS: Record<string, ImageOp> = {
  rotate_left: 'rotateLeft',
  rotate_right: 'rotateRight',
  rotate_180: 'rotate180',
  flip_horizontal: 'flipHorizontal',
  flip_vertical: 'flipVertical',
  grayscale: 'grayscale',
  sepia: 'sepia',
  invert: 'invert',
  blur: 'blur',
  sharpen: 'sharpen',
  auto_levels: 'autoLevels',
};

/** The colour or gradient an operation paints with: `color`, and for a gradient `gradient_to` (with `gradient_type`, and `angle` for a linear one). */
function paintArgs(args: Record<string, unknown>): Background {
  const hex = (key: string): string | undefined => {
    const v = args[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`\`${key}\` must be like #e53935.`);
    return v;
  };
  const from = hex('color');
  if (!from) throw new Error('`color` is the colour to paint with, like #e53935.');
  const to = hex('gradient_to');
  if (!to) return { color: from };
  const type = args.gradient_type === undefined ? 'linear' : args.gradient_type;
  if (type !== 'linear' && type !== 'radial') throw new Error('`gradient_type` must be linear or radial.');
  return { color: from, gradient: { type, to, angle: args.angle === undefined ? 90 : wholeNumber(args, 'angle', 0, 360) } };
}

/**
 * The assistant's tools, and what it needs to know of each request: `begin` when one starts (the
 * document open then is the one it is about), `run` for each tool it calls.
 */
export function appTools(host: AppToolsHost): { begin(request: AbortSignal): void; run(name: string, argumentsJson: string, request: AbortSignal): Promise<ToolResult> } {
  /** The document open when each of the assistant's requests started: its edits are for that one. */
  const assistantDocs = new WeakMap<AbortSignal, object>();

  /** The large-text editor, which the text_file tools need. */
  const textEditor = (): TextEditorTools => {
    const editor = host.textEditor();
    if (!editor) throw new Error('no text file is open. text_file is only for a plain text file in the text editor.');
    return editor;
  };

  /** Runs one of the layout worker's tools for another tool, and answers with its text (the pictures a tool fetches are only for the model). */
  const workerText = async (name: string, args: string): Promise<string> => {
    const result = await host.agent(name, args);
    return typeof result === 'string' ? result : result.text;
  };

  const files = fileTools(host.files);
  const tools: Record<string, (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult> = {
    ...files,
    async list_pictures() {
      // The open document's pictures are the layout worker's to find; the library's are listed here.
      return `${await workerText('list_pictures', '{}')}\n${await host.otherDocuments.describePictureFiles()}`;
    },
    view_picture(args) {
      // The person's other documents (this browser's, the account's and shared ones) are the library's, found and opened the way search_documents does.
      if (args.source === 'library') {
        if (typeof args.document !== 'string') return 'Error: `document` must be text: an id or a name.';
        return host.otherDocuments.picture(args.document, optionalNumber(args, 'number', 0, 0, 1000));
      }
      return host.agent('view_picture', JSON.stringify(args));
    },
    list_documents: (args) => host.otherDocuments.describeAll(optionalNumber(args, 'start', 0, 0, 100_000), optionalNumber(args, 'count', 30, 1, 100)),
    search_documents(args) {
      if (typeof args.query !== 'string') return 'Error: `query` must be text.';
      return host.otherDocuments.search(args.query);
    },
    read_other_document(args) {
      if (typeof args.document !== 'string') return 'Error: `document` must be text: an id or a name.';
      return host.otherDocuments.read(args.document, optionalNumber(args, 'start', 0, 0, 1_000_000), optionalNumber(args, 'count', 40, 1, 100));
    },
    async insert_from_document(args) {
      if (typeof args.document !== 'string') return 'Error: `document` must be text: an id or a name.';
      const found = await host.otherDocuments.paragraphs(args.document);
      if (typeof found === 'string') return found;
      const { name, segments } = found;
      if (!segments.length) return `Error: "${name}" has no text to copy.`;
      const first = wholeNumber(args, 'start', 0, Math.max(0, segments.length - 1));
      const last = optionalNumber(args, 'end', first, first, Math.max(first, segments.length - 1));
      if (last - first + 1 > MAX_COPY) return `Error: copy at most ${MAX_COPY} paragraphs at a time.`;
      const after = wholeNumber(args, 'after', -1, 1_000_000);
      // Put in one paragraph at a time with the tools the model has itself, so each is an ordinary, undoable edit.
      for (let k = first; k <= last; k++) {
        const seg = segments[k]!;
        const at = after + (k - first);
        const added = await workerText('insert_paragraph', JSON.stringify({ after: at, text: seg.text, style: seg.style ?? 'Normal' }));
        if (added.startsWith('Error:')) return `${added} Copied ${k - first} of ${last - first + 1} paragraphs from "${name}" before stopping.`;
        if (seg.list) await workerText('format_paragraph', JSON.stringify({ paragraph: at + 1, list: seg.list }));
      }
      const count = last - first + 1;
      return `Copied ${count === 1 ? `paragraph ${first}` : `paragraphs ${first} to ${last}`} of "${name}" into this document as paragraphs ${after + 1} to ${after + count}. Pictures and tables in them are not carried over, only their text; undo steps back.`;
    },
    get_document_info: () => {
      const large = host.textEditor();
      if (large) return `The document is "${host.documentName()}", ${large.describe()}. Use text_file to read and change it; it cannot be converted.`;
      return `The document is "${host.documentName()}", edited as ${formatLabel(host.documentKind())}. It can be converted to: ${FORMAT_LIST.map(formatLabel).join(', ')}.`;
    },
    text_file_info: () => `"${host.documentName()}" is ${textEditor().describe()}.`,
    text_file_read: (args) => textEditor().read(optionalNumber(args, 'line', 1, 1, 2_000_000_000), optionalNumber(args, 'count', 40, 1, 200)),
    text_file_find: (args) => textEditor().findAll(searchOptions(args)),
    text_file_replace(args) {
      if (typeof args.with !== 'string') throw new Error('`with` must be text (it may be empty).');
      return textEditor().replaceFile(searchOptions(args), args.with);
    },
    text_file_edit_lines(args) {
      const line = wholeNumber(args, 'line', 1, 2_000_000_000);
      if (typeof args.text !== 'string') throw new Error('`text` must be text (it may be empty).');
      return textEditor().editLines(line, optionalNumber(args, 'last_line', line, line, 2_000_000_000), args.text);
    },
    text_file_insert_lines(args) {
      if (typeof args.text !== 'string') throw new Error('`text` must be text.');
      return textEditor().insertLines(wholeNumber(args, 'line', 0, 2_000_000_000), args.text);
    },
    text_file_delete_lines(args) {
      const line = wholeNumber(args, 'line', 1, 2_000_000_000);
      return textEditor().deleteLines(line, optionalNumber(args, 'last_line', line, line, 2_000_000_000));
    },
    text_file_undo: () => textEditor().undoStep(),
    text_file_redo: () => textEditor().redoStep(),
    rename_document(args) {
      if (typeof args.name !== 'string') return 'Error: `name` must be text.';
      if (!host.renamable()) return 'Error: this document cannot be renamed.';
      const kept = host.renameDocument(args.name);
      return kept === null ? 'Error: that is not a usable name.' : `The document is now named "${displayDocumentName(kept, host.documentKind())}".`;
    },
    async convert_document(args) {
      const to = args.to;
      const from = host.documentKind();
      if (typeof to !== 'string' || !isFormat(to)) return `Error: \`to\` must be one of ${FORMAT_LIST.join(', ')}.`;
      if (to === from) return `The document is already ${formatLabel(from)}.`;
      if (host.inRoom()) return 'Error: a document being edited together with other people cannot be converted.';
      await host.convertTo(to);
      return host.documentKind() === to
        ? `Converted: the document is now edited as ${formatLabel(to)}. It is the same document, so switching back restores anything ${formatLabel(to)} could not hold. Paragraph numbers may differ now; read the document again before editing.`
        : 'Error: the document could not be converted.';
    },
    async open_file(args) {
      const entry = host.files.entries().find((e) => e.key === args.file);
      if (!entry) return `Error: there is no document ${String(args.file)}; list_files gives the ids.`;
      await host.openEntry(entry);
      return `Opened "${entry.name}". The tools now work on it; read it before editing.`;
    },
    async new_document(args) {
      const folder = args.folder;
      if (folder !== undefined && folder !== null && (typeof folder !== 'string' || !(await host.files.folders()).some((f) => f.id === folder))) return `Error: there is no folder ${String(folder)}.`;
      if (args.name !== undefined && typeof args.name !== 'string') return 'Error: `name` must be text.';
      if (args.type !== undefined && !NEW_KINDS.includes(args.type as DocumentKind)) return `Error: \`type\` must be one of ${NEW_KINDS.join(', ')}.`;
      await host.newDocument((folder as string | null | undefined) ?? null, args.type as DocumentKind | undefined);
      const named = typeof args.name === 'string' ? host.renameDocument(args.name) : null;
      return `Opened a new blank document${named ? ` named "${displayDocumentName(named, host.documentKind())}"` : ''}; it is saved once something is written in it. The tools now work on it.`;
    },
    download_all() {
      void host.perform({ kind: 'downloadAll' });
      return 'Started downloading all the documents as one ZIP file.';
    },
    download_document() {
      void host.perform({ kind: 'download' });
      return `Started the download of a copy as ${formatLabel(host.documentKind())}.`;
    },
    print_document(args) {
      const preview = optionalFlag(args, 'preview') ?? false;
      void host.perform({ kind: preview ? 'printPreview' : 'print' });
      return preview ? 'Opened the print preview.' : 'Opened printing.';
    },
    set_view(args) {
      const done: string[] = [];
      const mode = args.view_mode;
      if (mode !== undefined) {
        if (mode !== 'print' && mode !== 'flow' && mode !== 'grid') throw new Error('`view_mode` must be print, flow or grid.');
        void host.perform({ kind: 'viewMode', mode });
        done.push(`view ${mode}`);
      }
      const zoom = args.zoom;
      if (zoom !== undefined) {
        if (zoom === 'page_width' || zoom === 'whole_page' || zoom === 'all_pages') void host.perform({ kind: 'zoom', to: zoom === 'page_width' ? 'pageWidth' : zoom === 'whole_page' ? 'wholePage' : 'allPages' });
        else if (typeof zoom === 'number' && zoom >= 10 && zoom <= 500) void host.perform({ kind: 'zoom', to: zoom / 100 });
        else throw new Error('`zoom` must be a percentage from 10 to 500, or page_width, whole_page or all_pages.');
        done.push(`zoom ${String(zoom)}`);
      }
      const bar = optionalFlag(args, 'status_bar');
      if (bar !== undefined && bar !== host.view().statusBar) {
        void host.perform({ kind: 'toggleFooter' });
        done.push(`status bar ${bar ? 'on' : 'off'}`);
      }
      const ruler = optionalFlag(args, 'ruler');
      if (ruler !== undefined && ruler !== host.view().ruler) {
        void host.perform({ kind: 'toggleRuler' });
        done.push(`ruler ${ruler ? 'on' : 'off'}`);
      }
      const marks = optionalFlag(args, 'formatting_marks');
      if (marks !== undefined && marks !== host.view().formattingMarks) {
        void host.perform({ kind: 'toggleFormattingMarks' });
        done.push(`formatting marks ${marks ? 'on' : 'off'}`);
      }
      if (!done.length) throw new Error('Say what to change: view_mode, zoom, status_bar, ruler or formatting_marks.');
      return `Changed the view: ${done.join(', ')}.`;
    },
    set_drawing_options(args) {
      const done: string[] = [];
      const pencil = optionalFlag(args, 'select_after_pencil');
      if (pencil !== undefined) {
        setSelectAfterPencil(pencil);
        done.push(`select after pencil ${pencil ? 'on' : 'off'}`);
      }
      const back = optionalFlag(args, 'return_to_select');
      if (back !== undefined) {
        setReturnToSelect(back);
        done.push(`return to Select ${back ? 'on' : 'off'}`);
      }
      const show = optionalFlag(args, 'show_guides');
      if (show !== undefined) {
        setShowGuides(show);
        done.push(`guides ${show ? 'shown' : 'hidden'}`);
      }
      const lock = optionalFlag(args, 'lock_guides');
      if (lock !== undefined) {
        setLockGuides(lock);
        done.push(`guides ${lock ? 'locked' : 'unlocked'}`);
      }
      const pressure = optionalFlag(args, 'pen_pressure');
      if (pressure !== undefined) {
        setPenPressure(pressure);
        done.push(`pen pressure ${pressure ? 'on' : 'off'}`);
      }
      const smoothing = args.pencil_smoothing;
      if (smoothing !== undefined) {
        const level = SMOOTHING_LEVELS.find((l) => l === smoothing);
        if (!level) throw new Error('`pencil_smoothing` must be off, low, medium or high.');
        setPencilSmoothing(level);
        done.push(`pencil smoothing ${level}`);
      }
      if (!done.length) throw new Error('Say what to change: select_after_pencil, return_to_select, pencil_smoothing, pen_pressure, show_guides or lock_guides.');
      return `Changed the drawing options: ${done.join(', ')}.`;
    },
    async read_drawing() {
      const editor = await host.drawing();
      if (!editor?.drawing) return 'Error: the open document is not a vector drawing (SVG). Convert it to SVG to edit it as one.';
      return describeDrawing(editor.drawing);
    },
    async edit_drawing(args) {
      const editor = await host.drawing();
      if (!editor?.drawing) return 'Error: the open document is not a vector drawing (SVG), and no drawing in its text is open. Convert it to SVG, or open one with text_drawings.';
      return `${await editDrawing(editor, args)}\n${describeDrawing(editor.drawing)}`;
    },
    async list_text_drawings() {
      const list = host.textDrawings();
      if (!list.length) return 'There are no drawings in the text. insert puts a new one in.';
      return list.map((d, i) => `${i}: page ${d.page}, ${d.width} x ${d.height} px${d.embed ? `, embedded from "${d.embed}"` : ''}`).join('\n');
    },
    async insert_text_drawing(args) {
      const size = { ...(args.width !== undefined && { width: wholeNumber(args, 'width', 16, 4000) }), ...(args.height !== undefined && { height: wholeNumber(args, 'height', 16, 4000) }) };
      const problem = await host.insertTextDrawing(size);
      if (problem) return `Error: ${problem}`;
      return 'Inserted a blank drawing at the caret and opened it for drawing: edit_drawing draws in it, and text_drawings close puts it back in the text.';
    },
    async open_text_drawing(args) {
      const number = wholeNumber(args, 'number', 0, 100_000);
      const problem = await host.openTextDrawing(number);
      if (problem) return `Error: ${problem}`;
      return `Opened drawing ${number} for editing in place: read_drawing shows it, edit_drawing changes it, and text_drawings close puts it back in the text.`;
    },
    async close_text_drawing() {
      const problem = await host.closeTextDrawing();
      return problem ? `Error: ${problem}` : 'The drawing is back in the text.';
    },
    async collaboration_status() {
      const info = host.collaboration();
      if (!info.shared) return 'Nobody else is editing this document now.';
      const who = info.people.length ? `Here now: ${info.people.join(', ')}.` : `${info.count} people are here now.`;
      const holder = info.holder;
      if (!holder) return `${who} Everyone can edit at once.`;
      if (holder.here) return `${who} This kind of document is edited by one person at a time, and the person holds it: the others see each save.`;
      const by = holder.mine ? 'the person, on another of their devices' : holder.name;
      return `${who} This kind of document is edited by one person at a time, and ${by} holds it: the person sees each save, and can change it only after taking it over (collaboration take_over).`;
    },
    async take_over_editing() {
      if (!host.takeOver()) return 'Nobody else holds this document: it can be edited now.';
      return 'Asked to take it over: whoever holds it saves what they have first, then it can be edited here (in a few seconds at most). Check with collaboration status before changing it.';
    },
    async edit_picture(args) {
      if (!host.isPicture()) return 'Error: the open document is not a picture. Convert it to png, jpeg or webp to edit it as one.';
      const op = args.op;
      if (typeof op !== 'string') throw new Error('`op` must be text.');
      const size = sniffImage(await host.pictureBytes());
      if (!size) throw new Error('the picture could not be read');
      // Shapes drawn over the picture are its layers: they are listed, changed and put into the picture here.
      if (op === 'layers') return describeLayers(host.pictureShapes());
      const held = host.watching();
      if (held) return `Error: ${held}`;
      if ((LAYER_OPS as readonly string[]).includes(op)) {
        const next = layerOp(op, args, host.pictureShapes(), size);
        await host.setPictureShapes([...next.shapes]);
        return next.message;
      }
      if (op === 'flatten') {
        if (!host.pictureShapes().length) return 'There are no shapes to put into the picture.';
        await host.changePicture({ op: 'draw', shapes: [] });
        return 'Done: the shapes are in the picture now (they are not layers any more).';
      }
      let edit: ImageEdit;
      if (Object.hasOwn(IMAGE_OPS, op)) {
        const name = IMAGE_OPS[op]!;
        edit = name === 'rotateLeft' ? { op: 'rotate', turns: 3 } : name === 'rotateRight' ? { op: 'rotate', turns: 1 } : name === 'rotate180' ? { op: 'rotate', turns: 2 } : name === 'flipHorizontal' ? { op: 'flip', axis: 'horizontal' } : name === 'flipVertical' ? { op: 'flip', axis: 'vertical' } : { op: 'effect', effect: name as 'grayscale' };
      } else if (op === 'crop') {
        const x = wholeNumber(args, 'x', 0, size.width - 1);
        const y = wholeNumber(args, 'y', 0, size.height - 1);
        edit = { op: 'crop', x, y, width: wholeNumber(args, 'width', 1, size.width - x), height: wholeNumber(args, 'height', 1, size.height - y) };
      } else if (op === 'resize') {
        edit = { op: 'resize', width: wholeNumber(args, 'width', 1, MAX_SIDE), height: wholeNumber(args, 'height', 1, MAX_SIDE) };
      } else if (op === 'adjust') {
        const part = (key: string) => (args[key] === undefined ? 0 : wholeNumber(args, key, -100, 100));
        edit = { op: 'adjust', brightness: part('brightness'), contrast: part('contrast'), saturation: part('saturation') };
      } else if (op === 'set_background') {
        edit = { op: 'background', paint: paintArgs(args) };
      } else if (op === 'set_canvas') {
        const anchor = args.anchor === undefined ? 'center' : args.anchor;
        if (typeof anchor !== 'string' || !(ANCHORS as readonly string[]).includes(anchor)) throw new Error(`\`anchor\` must be one of ${ANCHORS.join(', ')}.`);
        edit = { op: 'canvas', width: wholeNumber(args, 'width', 1, MAX_SIDE), height: wholeNumber(args, 'height', 1, MAX_SIDE), anchor: anchor as (typeof ANCHORS)[number], ...(args.color !== undefined && { paint: paintArgs(args) }) };
      } else {
        throw new Error(`\`op\` must be one of ${[...Object.keys(IMAGE_OPS), 'crop', 'resize', 'adjust', 'set_background', 'set_canvas', ...LAYER_OPS, 'flatten'].join(', ')}.`);
      }
      await host.changePicture(edit);
      return `Done: ${op.replaceAll('_', ' ')} (the picture is ${size.width} x ${size.height} before the change; undo steps back).`;
    },
  };

  async function run(name: string, argumentsJson: string, request: AbortSignal): Promise<ToolResult> {
    const handler = Object.hasOwn(tools, name) ? tools[name] : undefined;
    // Another document was opened since the request started (by the person, or a file tool): these
    // tools would read and change that one instead, without anyone meaning them to.
    if (!ELSEWHERE_TOOLS.has(name) && !Object.hasOwn(files, name) && assistantDocs.get(request) !== host.current()) {
      return `Error: the document this request was about is no longer open (now open: "${host.documentName()}"). Nothing was done; tell the user, and ask before working on this one.`;
    }
    // A big text file is shown in an editor of its own, and the document under it is empty: the paragraph tools would work on that.
    if (!handler && host.textEditor()) return 'Error: the open file is a plain text file, which has lines rather than paragraphs. Only text_file works on it (info, read, find, replace, edit_lines, insert_lines, delete_lines, undo, redo).';
    if (!handler) return host.agent(name, argumentsJson);
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = argumentsJson.trim() ? JSON.parse(argumentsJson) : {};
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'Error: the arguments must be an object.';
      args = parsed as Record<string, unknown>;
    } catch {
      return 'Error: the arguments were not valid JSON.';
    }
    try {
      return await handler(args);
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    } finally {
      if (OPENING_TOOLS.has(name)) assistantDocs.set(request, host.current());
    }
  }

  return { begin: (request) => void assistantDocs.set(request, host.current()), run };
}
