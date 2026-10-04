// The assistant's tools that act on the app rather than the document's text: the person's files,
// their other documents, what the open document is (its name, its format, its view) and picture
// edits. The rest run in the layout worker (../layout/agentTools.ts). The app's state comes through
// the host, so these use the same functions the menus do.

import { describeDrawing, editDrawing } from './drawingTools.ts';
import { SMOOTHING_LEVELS, setLockGuides, setPencilSmoothing, setReturnToSelect, setSelectAfterPencil, setShowGuides } from '../ui/drawingOptions.ts';
import type { DrawingEditor } from './drawingTools.ts';
import type { ImageEdit } from '../formats/imageEdit.ts';
import { shiftShape } from '../formats/imageDraw.ts';
import type { Shape } from '../formats/imageDraw.ts';
import { FORMAT_LIST, isFormat } from '../formats/convert.ts';
import { sniffImage } from '../formats/images.ts';
import { MAX_SIDE } from '../formats/imagePixels.ts';
import { displayDocumentName } from '../documentName.ts';
import type { LibraryEntry } from '../sync.ts';
import type { Action, ImageOp } from '../ui/actions.ts';
import { FORMATS } from '../ui/formats.ts';
import type { DocumentKind } from '../ui/actions.ts';
import type { ToolResult } from './conversation.ts';
import { fileTools, type FileToolsHost } from './fileTools.ts';
import type { OtherDocuments } from './libraryDocs.ts';
import { MAX_COPY } from './otherDocs.ts';

export interface AppToolsHost {
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
  newDocument(folderId: string | null): Promise<void>;
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
  /** Who is editing the open document, and for a drawing only one person at a time may edit, who may. */
  collaboration(): Collaboration;
  /** Asks for, or lets go of, the right to edit such a drawing, and says how it stands once answered. */
  lease(action: 'request' | 'release'): Promise<Collaboration>;
  /** The shapes drawn over the open picture (its layers), and a change of them (resolving once it has taken effect). */
  pictureShapes(): readonly Shape[];
  setPictureShapes(shapes: Shape[]): Promise<void>;
  /** Others are editing the open document now (changes to a picture itself are not possible then). */
  sharedLive(): boolean;
}

/** Who is editing the open document. */
export interface Collaboration {
  /** Others are here with the person. */
  shared: boolean;
  /** Everyone's names when known (yours marked), else how many. */
  people: string[];
  count: number;
  /** Only one person at a time may edit this document (a drawing). */
  exclusive: boolean;
  /** This person may edit it now. */
  mine: boolean;
  /** Who may, when somebody does. */
  holder: string | null;
}

/** The app's tools that act on the open document (the others are about the library). */
const OPEN_DOCUMENT_APP_TOOLS = new Set(['read_drawing', 'edit_drawing', 'list_text_drawings', 'insert_text_drawing', 'open_text_drawing', 'close_text_drawing', 'collaboration_status', 'take_over_editing', 'release_editing', 'view_picture', 'rename_document', 'download_document', 'print_document', 'convert_document']);
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
const DRAWN = ['line', 'arrow', 'rectangle', 'ellipse', 'text'] as const;

const SHARED_PICTURE = 'others are editing this picture now, so changes to the picture itself (crop, resize, rotate, flip, colours, effects, flatten) are not available; draw, layers, erase_shape and move_shape are.';

/** Who may edit a shared drawing, in a sentence. */
function hold(info: Collaboration): string {
  if (info.mine) return 'This person may edit the drawing.';
  return info.holder ? `${info.holder} is editing this drawing now.` : 'Nobody holds the right to edit this drawing now.';
}

/** The shapes drawn over a picture, back to front, numbered from 0. */
function describeShapes(shapes: readonly Shape[]): string {
  if (!shapes.length) return 'No shapes are drawn over the picture.';
  return shapes
    .map((s, i) => {
      const [a, b] = [s.points[0], s.points[s.points.length - 1]];
      const where = s.points.length > 1 ? ` from (${Math.round(a.x)}, ${Math.round(a.y)}) to (${Math.round(b.x)}, ${Math.round(b.y)})` : ` at (${Math.round(a.x)}, ${Math.round(a.y)})`;
      return `${i}: ${s.tool}${where}; ${s.color}; width ${s.width}${s.text ? `; "${s.text}"` : ''}${s.fill ? '; filled' : ''}`;
    })
    .join('\n');
}

/**
 * The assistant's tools, and what it needs to know of each request: `begin` when one starts (the
 * document open then is the one it is about), `run` for each tool it calls.
 */
export function appTools(host: AppToolsHost): { begin(request: AbortSignal): void; run(name: string, argumentsJson: string, request: AbortSignal): Promise<ToolResult> } {
  /** The document open when each of the assistant's requests started: its edits are for that one. */
  const assistantDocs = new WeakMap<AbortSignal, object>();

  /** Runs one of the layout worker's tools for another tool, and answers with its text (the pictures a tool fetches are only for the model). */
  const workerText = async (name: string, args: string): Promise<string> => {
    const result = await host.agent(name, args);
    return typeof result === 'string' ? result : result.text;
  };

  const tools: Record<string, (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult> = {
    ...fileTools(host.files),
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
    get_document_info: () => `The document is "${host.documentName()}", edited as ${formatLabel(host.documentKind())}. It can be converted to: ${FORMAT_LIST.map(formatLabel).join(', ')}.`,
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
      await host.newDocument((folder as string | null | undefined) ?? null);
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
      const smoothing = args.pencil_smoothing;
      if (smoothing !== undefined) {
        const level = SMOOTHING_LEVELS.find((l) => l === smoothing);
        if (!level) throw new Error('`pencil_smoothing` must be off, low, medium or high.');
        setPencilSmoothing(level);
        done.push(`pencil smoothing ${level}`);
      }
      if (!done.length) throw new Error('Say what to change: select_after_pencil, return_to_select, pencil_smoothing, show_guides or lock_guides.');
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
      if (editor.readOnly) return `Error: ${hold(host.collaboration())} Nothing was changed; use collaboration (take_over) if the person wants to edit it.`;
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
      const who = info.people.length ? `Editing now: ${info.people.join(', ')}.` : `${info.count} people are editing now.`;
      return info.exclusive ? `${who} ${hold(info)}` : `${who} Everyone can edit at once.`;
    },
    async take_over_editing() {
      const before = host.collaboration();
      if (!before.exclusive) return 'Nothing to take over: everyone can edit this document at once.';
      if (before.mine) return 'This person already may edit the drawing.';
      const after = await host.lease('request');
      return after.mine ? 'This person may edit the drawing now.' : `Refused: ${hold(after)} It is given up when they stop working for a while; do not keep asking.`;
    },
    async release_editing() {
      const before = host.collaboration();
      if (!before.exclusive || !before.mine) return 'This person is not the one editing a shared drawing, so there is nothing to let go of.';
      const after = await host.lease('release');
      return after.mine ? 'It could not be let go of.' : 'Let go: others may edit the drawing now.';
    },
    async edit_picture(args) {
      if (!host.isPicture()) return 'Error: the open document is not a picture. Convert it to png, jpeg or webp to edit it as one.';
      const op = args.op;
      if (typeof op !== 'string') throw new Error('`op` must be text.');
      const size = sniffImage(await host.pictureBytes());
      if (!size) throw new Error('the picture could not be read');
      // Shapes drawn over the picture are its layers: they are listed, changed and put into the picture here.
      if (op === 'layers') return describeShapes(host.pictureShapes());
      if (op === 'erase_shape' || op === 'move_shape') {
        const shapes = host.pictureShapes();
        const at = wholeNumber(args, 'number', 0, Math.max(0, shapes.length - 1));
        if (!shapes.length) return 'Error: there are no shapes drawn over the picture.';
        const next = op === 'erase_shape' ? shapes.filter((_, i) => i !== at) : shapes.map((s, i) => (i === at ? shiftShape(s, wholeNumber(args, 'dx', -size.width, size.width), wholeNumber(args, 'dy', -size.height, size.height)) : s));
        await host.setPictureShapes([...next]);
        return `Done: ${op.replace('_', ' ')} ${at}.\n${describeShapes(host.pictureShapes())}`;
      }
      if (op === 'flatten') {
        if (!host.pictureShapes().length) return 'There are no shapes to put into the picture.';
        if (host.sharedLive()) return `Error: ${SHARED_PICTURE}`;
        await host.changePicture({ op: 'draw', shapes: [] });
        return 'Done: the shapes are in the picture now (they are not layers any more).';
      }
      // The rest change the picture itself, which others editing it at the same time cannot be given.
      if (op !== 'draw' && host.sharedLive()) return `Error: ${SHARED_PICTURE}`;
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
      } else if (op === 'draw') {
        const tool = args.tool;
        if (typeof tool !== 'string' || !(DRAWN as readonly string[]).includes(tool)) throw new Error(`\`tool\` must be one of ${DRAWN.join(', ')}.`);
        const color = typeof args.color === 'string' && /^#[0-9a-f]{6}$/i.test(args.color) ? args.color : args.color === undefined ? '#e53935' : null;
        if (!color) throw new Error('`color` must be like #e53935.');
        const at = (px: string, py: string) => ({ x: wholeNumber(args, px, 0, size.width), y: wholeNumber(args, py, 0, size.height) });
        const points = tool === 'text' ? [at('x', 'y')] : [at('x', 'y'), at('to_x', 'to_y')];
        if (tool === 'text' && (typeof args.text !== 'string' || !args.text)) throw new Error('`text` is what to write.');
        const width = args.width === undefined ? Math.max(2, Math.round(Math.max(size.width, size.height) / 150)) : wholeNumber(args, 'width', 1, 200);
        const shape: Shape = { id: crypto.randomUUID().slice(0, 12), tool: tool as 'line', color, width, points, ...(optionalFlag(args, 'fill') && { fill: true }), ...(tool === 'text' && { text: args.text as string }) };
        // A shape is a layer over the picture (its pixels are not changed), and is shared with others editing it.
        await host.setPictureShapes([...host.pictureShapes(), shape]);
        return `Done: draw ${tool} as shape ${host.pictureShapes().length - 1} over the picture (it is ${size.width} x ${size.height}; layers lists the shapes).`;
      } else {
        throw new Error(`\`op\` must be one of ${[...Object.keys(IMAGE_OPS), 'crop', 'resize', 'adjust', 'draw', 'layers', 'erase_shape', 'move_shape', 'flatten'].join(', ')}.`);
      }
      await host.changePicture(edit);
      return `Done: ${op.replaceAll('_', ' ')} (the picture is ${size.width} x ${size.height} before the change; undo steps back).`;
    },
  };

  async function run(name: string, argumentsJson: string, request: AbortSignal): Promise<ToolResult> {
    const handler = Object.hasOwn(tools, name) ? tools[name] : undefined;
    // Another document was opened since the request started (by the person, or a file tool): these
    // tools would read and change that one instead, without anyone meaning them to.
    if ((!handler || OPEN_DOCUMENT_APP_TOOLS.has(name)) && assistantDocs.get(request) !== host.current()) {
      return `Error: the document this request was about is no longer open (now open: "${host.documentName()}"). Nothing was done; tell the user, and ask before working on this one.`;
    }
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
