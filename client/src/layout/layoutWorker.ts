// The layout worker: owns the open document, lays it out, applies edits and streams pages
// (as transferable GPU-ready buffers) and selection geometry to the page. Everything heavy
// happens here, so the page keeps rendering and responding while a document lays out.

import { isMathInline, paragraphLength, paragraphText, plainText, type DocumentProperties, type Inline, runPropertiesAt, WordDocument, type ParagraphProperties, type RunProperties } from '@word/docx';
import { Editor, type Command } from '@word/editor';
import { Replica, type RunFormat, type Pointer, type Selection as OpSelection, type Transaction } from '@word/ops';
import type { RoomClientMessage, RoomServerMessage } from '../collab/messages.ts';
import { RoomClient, type RoomHost, type RoomStart, type SocketLike } from '../collab/roomClient.ts';
import {
  describeFace,
  encodePage,
  FontSet,
  LayoutSession,
  setFormattingMarks,
  setReflowWidth,
  toModel,
  type EncodedPage,
  PageLayout,
  type FaceDescriptor,
} from '@word/layout';
import { exportDocument, importDocument, type Format } from '../formats/convert.ts';
import type { PdfView } from '../formats/pdfPages.ts';
import { sniffImage } from '../formats/images.ts';
import { readWdoc, WDOC_VERSION, writeWdoc, type Extensions } from '../formats/wdoc.ts';
import type { FormField } from '@word/pdf';
import type { PdfAnnotator } from './pdfAnnotator.ts';
import { getLocale, loadLocale, t } from '../i18n/index.ts';

/** The welcome text in the current language (`welcome/<locale>.md`), else English. Each is its own small chunk. */
const WELCOMES = import.meta.glob<string>('./welcome/*.md', { query: '?raw', import: 'default' });
/** The app's icon, inline at the start of the title (the first paragraph), level with its letters. Optional. */
async function addWelcomeIcon(document: WordDocument): Promise<void> {
  const title = document.body[0];
  if (title?.kind !== 'paragraph') return;
  try {
    const image = document.addImage(new Uint8Array(await (await fetchOk('/icon-512.png')).arrayBuffer()), 'png');
    const size = 24 * 12700; // 24 pt, in EMUs
    const drawing = { kind: 'drawing' as const, inline: true, width: size, height: size, image, name: 'Golem Docs', description: 'Golem Docs icon' };
    title.children.unshift(
      { kind: 'run', properties: { position: -6 }, content: [drawing], attrs: {} }, // lowered 3 pt: centered on the title's letters
      { kind: 'run', properties: {}, content: [{ kind: 'text', text: ' ' }], attrs: {} },
    );
    // A bigger title, to go with the icon.
    for (const run of title.children) if (run.kind === 'run') run.properties = { ...run.properties, size: 56, sizeCs: 56 };
  } catch {
    // no icon
  }
}

async function welcomeText(): Promise<string> {
  const load = WELCOMES[`./welcome/${getLocale()}.md`] ?? WELCOMES['./welcome/en.md'];
  return load();
}

/** The privacy policy or terms (`legal/<page>/<locale>.md`), else English. Each is its own small chunk. */
const LEGAL = import.meta.glob<string>('./legal/*/*.md', { query: '?raw', import: 'default' });
async function legalText(page: LegalPage): Promise<string> {
  const load = LEGAL[`./legal/${page}/${getLocale()}.md`] ?? LEGAL[`./legal/${page}/en.md`];
  return load();
}
/** CHANGELOG.md at the repository root (English only), its own chunk since it grows with every change. */
async function changelogText(): Promise<string> {
  return (await import('../../../CHANGELOG.md?raw')).default;
}
import { DICTIONARY_BASE, FONT_BASE, isPdfCommand, type LegalPage, type DocumentSource, type FromWorker, type LayoutUpdate, type RoomOptions, type SelectionUpdate, type SpellIssue, type ToWorker, type WireBox, type WireCommand, type WireField, type WirePickedObject, type WirePickedText } from './protocol.ts';
import { fontShowcase, plainTextDocument } from './samples.ts';
import { FormatReader } from './selectionFormat.ts';
import { runAgentTool } from './agentTools.ts';
import { formatCommand, type FormatAction } from './formatting.ts';
import { findIssues, type TextIssue } from '../spelling/check.ts';
import { countText } from './wordCount.ts';
import { htmlToPaste } from '../formats/paste.ts';
import { Dictionary } from '../spelling/dictionary.ts';

/** Milliseconds of layout between updates: small enough that the first pages show quickly. */
const SLICE_MS = 12;
/** Longest selection text kept for the clipboard. */
const CLIPBOARD_LIMIT = 4_000_000;

const fontsReady = FontSet.load(
  async (path) => {
    const response = await fetch(FONT_BASE + path);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}. Run \`pnpm fonts\`.`);
    return response.json();
  },
  async (path) => {
    const response = await fetch(FONT_BASE + path);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
);

function post(message: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

/** Yields to the worker's task queue, so commands and newer opens get in between slices. */
function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

/** A document as read from its source: the universal document (see ../formats/wdoc.ts). */
interface Loaded {
  name: string;
  /** The flowing document; null for a PDF that hasn't been reflowed. */
  document: WordDocument | null;
  extensions: Extensions;
  /** The original PDF, when the document came from one. */
  original: Uint8Array | null;
  /** What it is edited as, and what it was first imported from. */
  lens: Format;
  origin: Format;
  /** The original PDF's pages still show the document's text. */
  pagesCurrent: boolean;
}

async function load(source: DocumentSource, fonts: FontSet): Promise<Loaded> {
  const flowing = (name: string, document: WordDocument, lens: Format = 'docx', extensions: Extensions = {}): Loaded => ({
    name,
    document,
    extensions,
    original: null,
    lens,
    origin: lens,
    pagesCurrent: false,
  });
  switch (source.kind) {
    case 'pdf':
      return { name: source.name, document: null, extensions: {}, original: new Uint8Array(source.bytes), lens: 'pdf', origin: 'pdf', pagesCurrent: true };
    case 'md':
    case 'odt':
    case 'rtf':
    case 'epub':
    case 'csv':
    case 'tex':
    case 'adoc':
    case 'rst':
    case 'org':
    case 'mediawiki':
    case 'eml':
    case 'ipynb':
    case 'textile':
    case 'tsv':
    case 'mhtml':
    case 'html':
    case 'txt': {
      const { document, extensions } = await importDocument(source.kind, new Uint8Array(source.bytes));
      return flowing(source.name, document, source.kind, extensions);
    }
    case 'image': {
      const type = sniffImage(new Uint8Array(source.bytes))?.type;
      const lens: Format = type === 'jpeg' || type === 'webp' ? type : 'png';
      const { document, extensions } = await importDocument(lens, new Uint8Array(source.bytes));
      return flowing(source.name, document, lens, extensions);
    }
    case 'doc': {
      const { docToDocument } = await import('../formats/docImport.ts');
      return flowing(source.name, await docToDocument(new Uint8Array(source.bytes)));
    }
    case 'wdoc': {
      const wdoc = await readWdoc(new Uint8Array(source.bytes));
      // A PDF edited as something else, with its text unedited, is reflowed afresh: that picks up
      // annotations added on its own pages since.
      const reflowAgain = wdoc.original && wdoc.manifest.pagesCurrent && wdoc.manifest.lens !== 'pdf';
      return {
        name: source.name,
        document: wdoc.document && !reflowAgain ? await WordDocument.read(wdoc.document) : null,
        extensions: wdoc.extensions,
        original: wdoc.original,
        lens: wdoc.manifest.lens,
        origin: wdoc.manifest.origin,
        pagesCurrent: wdoc.manifest.pagesCurrent,
      };
    }
    case 'docx':
      return flowing(source.name, await WordDocument.read(new Uint8Array(source.bytes)));
    case 'docx-url':
      return flowing(source.name, await WordDocument.read(new Uint8Array(await (await fetchOk(source.url)).arrayBuffer())));
    case 'text-url':
      return flowing(source.name, await plainTextDocument(await (await fetchOk(source.url)).text()));
    case 'blank': {
      const blank = await WordDocument.create();
      blank.properties.created = now();
      return flowing(source.name, blank);
    }
    case 'fonts':
      return flowing('Fonts', await fontShowcase(fonts));
    case 'welcome': {
      // Written in Markdown for easy editing, then opened as an ordinary (Word) document.
      const { document, extensions } = await importDocument('md', new TextEncoder().encode(await welcomeText()));
      await addWelcomeIcon(document);
      return flowing(t('app.welcomeName'), document, 'docx', extensions);
    }
    case 'legal': {
      const { document, extensions } = await importDocument('md', new TextEncoder().encode(await legalText(source.page)));
      await addWelcomeIcon(document);
      return flowing(t(source.page === 'privacy' ? 'app.privacyName' : 'app.termsName'), document, 'docx', extensions);
    }
    case 'changelog': {
      const { document, extensions } = await importDocument('md', new TextEncoder().encode(await changelogText()));
      await addWelcomeIcon(document);
      return flowing(t('app.changelogName'), document, 'docx', extensions);
    }
  }
}

/** Commands that only look: allowed on a document shown as PDF, which can't be edited. */
const VIEW_COMMANDS = new Set<WireCommand['kind']>(['pointer', 'move', 'selectAll', 'find', 'spellNext', 'spellWords', 'spellCheck', 'spellAt', 'countWords', 'getProperties']);

/** Faces the page already has (it keeps them across documents). */
const sentFaces = new Set<string>();

interface Person {
  name: string;
  color: number;
  selection: OpSelection | null;
  pointer: Pointer | null;
}

class OpenDocument {
  /** What the document is edited as. As PDF it is shown but not edited. */
  format: Format = 'docx';
  /** What it was first imported from (kept in the .wdoc). */
  origin: Format = 'docx';
  /** What only one format can express (see ../formats/wdoc.ts). */
  extensions: Extensions = {};
  /** The original PDF, when the document came from one. */
  original: Uint8Array | null = null;
  /** The original PDF's pages showed the document's text when it was opened. */
  pagesCurrent = false;
  /** The text was edited since it was opened. */
  edited = false;
  /** When showing a PDF's own pages: its lazily laid-out pages. */
  pdf: { view: PdfView; bytes: Uint8Array } | null = null;
  /** Selecting a PDF's text and marking it up, when showing its own pages. */
  annotator: PdfAnnotator | null = null;
  /** The PDF's pages laid out so far, in order. */
  private pdfPages: PageLayout[] = [];
  /** Ids for PDF pages laid out again (the first layout of page i has id i). */
  private nextPdfPageId = 0;
  document: WordDocument | null = null;
  replica: Replica | null = null;
  session: LayoutSession | null = null;
  editor: Editor | null = null;
  formats: FormatReader | null = null;
  /** Collaboration: the room, other people in it, room messages that came before we were ready. */
  room: Extract<RoomOptions, { kind: 'dev' }> | null = null;
  /** The multiplayer server's room, for a cloud document. */
  net: RoomClient | null = null;
  private clientId = '';
  private readonly people = new Map<string, Person>();
  private backlog: RoomServerMessage[] = [];
  private joined: ((m: Extract<RoomServerMessage, { type: 'joined' }>) => void) | null = null;
  private count = 1;
  private lastPresence = '';
  readonly controller = new AbortController();
  /** Page ids the page thread holds. */
  private readonly shown = new Set<number>();
  private pending: PageLayout[] = [];
  private overlays: { page: PageLayout; content: PageLayout }[] = [];
  private pumping = false;
  /** Scroll the caret into view with the next selection update. */
  reveal = false;
  /** When the last command arrived (for the latency readout). */
  private commandAt = 0;
  /** The result of the last Find or Replace All, sent with the next selection. */
  private search: SelectionUpdate['search'] | null = null;
  /** What the last Spelling and Grammar step found, sent with the next selection. */
  private spell: SelectionUpdate['spell'] | null = null;
  /** Check-as-you-type is waiting for the dictionary to load. */
  private loadingMarks = false;
  /** The last Word Count's answer, sent with the next selection (null: none to give). */
  private stats: SelectionUpdate['stats'] = undefined;
  /** The document's properties, asked for by File ▸ Properties, sent with the next selection. */
  private props: DocumentProperties | undefined = undefined;
  /** Formatting the Format Painter has picked up: the paragraph's only when a whole paragraph was copied. */
  private painter: { run: RunProperties; paragraph: ParagraphProperties | null } | null = null;

  constructor(readonly doc: number) {}

  get closed(): boolean {
    return this.controller.signal.aborted;
  }

  /** Lays the whole document out again (the pages' look changed, not the text). */
  relayout(): void {
    const session = this.session;
    if (!session || this.closed || this.format === 'pdf') return;
    session.invalidate([], { structural: true });
    void this.pump();
  }

  /** Lays out until the pages are current, sending updates as it goes. */
  async pump(): Promise<void> {
    const session = this.session!;
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (session.needsLayout && !this.closed) {
        const result = await session.run({
          onPage: (page) => this.pending.push(page),
          onHeaderFooter: (page, content) => this.overlays.push({ page, content }),
          onSlice: async () => {
            this.flush();
            await yieldTask();
          },
          sliceMs: SLICE_MS,
          signal: this.controller.signal,
          mergeOverlays: false,
        });
        if (result.completed) this.flush();
      }
    } catch (e) {
      if (!this.closed) throw e;
    } finally {
      this.pumping = false;
    }
  }

  /** Lays out a PDF's pages one after another, sending them as they come (first pages appear at once). */
  async pumpPdf(): Promise<number> {
    const { view } = this.pdf!;
    const start = performance.now();
    let sliceStart = start;
    for (let i = 0; i < view.pageCount && !this.closed; i++) {
      let page: PageLayout;
      try {
        page = view.layoutPage(i, this.nextPdfPageId++);
      } catch (e) {
        // One unreadable page mustn't lose the rest: show it blank.
        console.error(e);
        page = new PageLayout(this.nextPdfPageId++, 612, 792, 0, i + 1);
      }
      this.pdfPages.push(page);
      this.pending.push(page);
      if (performance.now() - sliceStart > SLICE_MS) {
        this.flush();
        await yieldTask();
        sliceStart = performance.now();
      }
    }
    if (!this.closed) this.flush();
    return performance.now() - start;
  }

  /** Lays PDF pages out again (their annotations changed), and sends them with the selection. */
  private relayoutPdf(pages: number[]): void {
    const { view } = this.pdf!;
    for (const index of pages) {
      if (index >= this.pdfPages.length) continue; // not laid out yet: it will show the change
      const page = view.layoutPage(index, this.nextPdfPageId++);
      this.pdfPages[index] = page;
      this.pending.push(page);
    }
    this.flush();
  }

  /** Sends new pages, overlays and the page order. */
  private flush(): void {
    const session = this.session;
    const transfer: Transferable[] = [];
    const faces: FaceDescriptor[] = [];
    const encode = (page: PageLayout): EncodedPage => {
      const encoded = encodePage(page);
      transfer.push(...encoded.transferables);
      for (const metrics of encoded.faces) {
        if (sentFaces.has(metrics.face.atlas)) continue;
        sentFaces.add(metrics.face.atlas);
        const face = describeFace(metrics);
        faces.push(face);
        transfer.push(face.glyphTable.buffer);
      }
      return encoded.page;
    };
    // Pages to keep on the page thread: those shown now, and kept pages a running layout
    // may still reuse.
    const display = session ? session.displayPages : this.pdfPages;
    const keep = new Set<number>();
    for (const page of display) keep.add(page.id);
    if (session) for (const page of session.pages) keep.add(page.id);

    // Pages from a superseded run may already be out of date: those aren't sent at all.
    const pages = this.pending
      .filter((page) => keep.has(page.id))
      .map((page) => {
        this.shown.add(page.id);
        return encode(page);
      });
    const overlays = this.overlays.filter(({ page }) => keep.has(page.id)).map(({ page, content }) => ({ page: page.id, content: encode(content) }));
    this.pending = [];
    this.overlays = [];
    const drop: number[] = [];
    for (const id of this.shown) {
      if (!keep.has(id)) {
        drop.push(id);
        this.shown.delete(id);
      }
    }
    const order = Int32Array.from(display, (page) => page.id);
    transfer.push(order.buffer);
    const selection = this.selection();
    if (selection) transfer.push(selection.rects.buffer, selection.commentRects.buffer, ...(selection.spellMarks ? [selection.spellMarks.buffer] : []));
    const update: LayoutUpdate = { faces, pages, overlays, order, drop, selection };
    post({ type: 'layout', doc: this.doc, ...update }, transfer);
  }

  sendSelection(): void {
    const selection = this.selection();
    if (selection) post({ type: 'selection', doc: this.doc, ...selection }, [selection.rects.buffer, selection.commentRects.buffer, ...(selection.spellMarks ? [selection.spellMarks.buffer] : [])]);
  }

  private selection(): SelectionUpdate | undefined {
    if (this.annotator && !this.closed) return this.pdfSelection(this.annotator);
    const editor = this.editor;
    if (!editor || this.closed) return undefined;
    const g = editor.geometry();
    const caret = (c: typeof g.caret) => (c ? { page: c.page.id, x: c.x, y: c.y, height: c.height } : null);
    const rects = new Float64Array(g.rects.length * 5);
    g.rects.forEach((r, i) => rects.set([r.page.id, r.x, r.y, r.width, r.height], i * 5));
    const remote: SelectionUpdate['remote'] = [];
    for (const person of this.people.values()) {
      const at = person.selection && editor.caretAt(person.selection.focus);
      if (at) remote.push({ page: at.page.id, x: at.x, y: at.y, height: at.height, color: person.color, name: person.name });
    }
    const remoteRects: SelectionUpdate['remoteRects'] = [];
    for (const person of this.people.values()) {
      const list = person.selection ? editor.rectsFor(person.selection) : [];
      if (list.length) remoteRects.push({ color: person.color, rects: list.flatMap((r) => [r.page.id, r.x, r.y, r.width, r.height]) });
    }
    const commented = editor.comments();
    const commentRects = new Float64Array(commented.reduce((n, c) => n + c.rects.length, 0) * 5);
    let k = 0;
    for (const c of commented) for (const r of c.rects) commentRects.set([r.page.id, r.x, r.y, r.width, r.height], 5 * k++);
    const update: SelectionUpdate = {
      caret: caret(g.caret),
      rects,
      comments: commented.map((c) => ({ id: c.id, author: c.author, initials: c.initials, date: c.date, parentId: c.parentId, resolved: c.resolved, text: c.text, page: c.rects[0]?.page.id ?? null, y: c.rects[0]?.y ?? 0 })),
      activeComment: editor.activeComment(),
      commentRects,
      spellMarks: this.spellMarks(editor),
      focus: caret(g.focus),
      reveal: this.reveal,
      text: editor.selectedText(CLIPBOARD_LIMIT),
      format: this.formats!.read(...editor.ordered(), editor.paragraphs(), editor.pending),
      canUndo: this.replica!.history.canUndo,
      canRedo: this.replica!.history.canRedo,
      workerMs: this.commandAt ? performance.now() - this.commandAt : 0,
      remote,
      search: this.search ?? undefined,
      remoteRects,
      painting: this.painter !== null,
      link: editor.selectedLink(),
      math: editor.selectedMath(),
      inTable: editor.inTable(),
      columns: editor.sectionColumns(),
      page: editor.sectionPage(),
      spell: this.spell ?? undefined,
      stats: this.stats,
      docProperties: this.props,
    };
    this.search = null;
    this.spell = null;
    this.stats = undefined;
    this.props = undefined;
    this.reveal = false;
    this.commandAt = 0;
    this.sendPresence();
    return update;
  }

  private pdfSelection(annotator: PdfAnnotator): SelectionUpdate {
    const rects = annotator.rects();
    const packed = new Float64Array(rects.length * 5);
    rects.forEach((r, i) => packed.set([this.pdfPages[r.page]?.id ?? -1, r.x, r.y, r.width, r.height], i * 5));
    const first = rects[0];
    const fontNotice = annotator.fontNotice();
    const update: SelectionUpdate = {
      caret: null,
      rects: packed,
      comments: [],
      activeComment: null,
      commentRects: new Float64Array(0),
      remoteRects: [],
      focus: first && this.pdfPages[first.page] ? { page: this.pdfPages[first.page].id, x: first.x, y: first.y, height: first.height } : null,
      reveal: this.reveal,
      text: annotator.selectedText(CLIPBOARD_LIMIT),
      format: {},
      canUndo: annotator.canUndo,
      canRedo: annotator.canRedo,
      workerMs: this.commandAt ? performance.now() - this.commandAt : 0,
      remote: [],
      stats: this.stats,
      docProperties: this.props,
      fields: annotator.fields.map((f) => this.wireField(f)).filter((f) => f !== null),
      pdfText: this.wirePicked(annotator),
      pdfObject: this.wireObject(annotator),
      ...(fontNotice.length > 0 && { pdfFontNotice: fontNotice }),
      ...(annotator.partialNotice() && { pdfNotice: 'partialRedaction' as const }),
    };
    this.reveal = false;
    this.commandAt = 0;
    return update;
  }

  /** The text being edited in place, as the page sees it (if its page has been laid out). */
  private wirePicked(annotator: PdfAnnotator): WirePickedText | null {
    const picked = annotator.picked;
    const page = picked && this.pdfPages[picked.page];
    if (!picked || !page) return null;
    const { view } = this.pdf!;
    const [ax, ay] = view.toPage(picked.page, picked.box[0], picked.box[1]);
    const [bx, by] = view.toPage(picked.page, picked.box[2], picked.box[3]);
    const [, baseline] = view.toPage(picked.page, picked.box[0], picked.baseline);
    return {
      pageId: page.id,
      id: picked.id,
      added: picked.runs === null,
      text: picked.text,
      box: { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) },
      baseline,
      style: picked.style,
    };
  }

  /** The selected picture or shape, as the page sees it (if its page has been laid out). */
  private wireObject(annotator: PdfAnnotator): WirePickedObject | null {
    const o = annotator.pickedObject;
    const page = o && this.pdfPages[o.page];
    if (!o || !page) return null;
    const hex = (c: readonly number[] | null) => (c ? `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}` : null);
    return {
      pageId: page.id,
      id: o.editId ?? o.target ?? '',
      kind: o.kind,
      box: this.pageBox(o.page, o.box),
      ...(o.shape && { shape: { shape: o.shape.shape, stroke: hex(o.shape.stroke), fill: hex(o.shape.fill), width: o.shape.width } }),
    };
  }

  /** A box in a page's user space as page coordinates. */
  private pageBox(page: number, box: readonly number[]): WireBox {
    const { view } = this.pdf!;
    const [ax, ay] = view.toPage(page, box[0], box[1]);
    const [bx, by] = view.toPage(page, box[2], box[3]);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
  }

  /** A box in page coordinates as user space [x0 y0 x1 y1]. */
  private userBox(page: number, box: WireBox): [number, number, number, number] {
    const { view } = this.pdf!;
    const [ax, ay] = view.toUser(page, box.x, box.y);
    const [bx, by] = view.toUser(page, box.x + box.width, box.y + box.height);
    return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  }

  /** A form field as the page sees it, if its page has been laid out. */
  private wireField(field: FormField): WireField | null {
    const page = this.pdfPages[field.page];
    if (!page) return null;
    const { view } = this.pdf!;
    const [ax, ay] = view.toPage(field.page, field.rect[0], field.rect[1]);
    const [bx, by] = view.toPage(field.page, field.rect[2], field.rect[3]);
    return { ...field, pageId: page.id, box: { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) } };
  }

  /** A field from the page: its box back in the page's user space (unless it didn't move). */
  private fieldFromWire(wire: WireField, before: Map<string, FormField>): FormField {
    const { pageId, box, ...field } = wire;
    const page = this.pdfPages.findIndex((p) => p.id === pageId);
    if (page >= 0) field.page = page;
    const was = before.get(field.id);
    const wasBox = was && was.page === field.page ? this.wireField(was)?.box : undefined;
    const same = wasBox && Math.abs(wasBox.x - box.x) < 0.01 && Math.abs(wasBox.y - box.y) < 0.01 && Math.abs(wasBox.width - box.width) < 0.01 && Math.abs(wasBox.height - box.height) < 0.01;
    if (same && was) return { ...field, rect: was.rect };
    const { view } = this.pdf!;
    const [ax, ay] = view.toUser(field.page, box.x, box.y);
    const [bx, by] = view.toUser(field.page, box.x + box.width, box.y + box.height);
    return { ...field, rect: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)] };
  }

  /** Commands on a PDF shown as its own pages: selecting text, and marking it up. */
  private pdfCommand(annotator: PdfAnnotator, wire: WireCommand): void {
    this.commandAt = performance.now();
    this.reveal = false;
    let changed: number[] = [];
    switch (wire.kind) {
      case 'pointer': {
        const index = this.pdfPages.findIndex((p) => p.id === wire.page);
        if (index < 0) break;
        // Something added to the page is picked by clicking it (Fill In mode: its text isn't for editing); anywhere else this is selecting text.
        if (!wire.extend) {
          const added = annotator.pickAdded(index, wire.x, wire.y);
          if (added.picked) {
            void this.afterPick(annotator, added.pages);
            return;
          }
          changed = annotator.deselect();
        }
        annotator.pointer(index, wire.x, wire.y, wire.extend ?? false, wire.unit ?? 'character');
        break;
      }
      case 'selectAll':
        annotator.selectPage();
        break;
      case 'annotate': {
        const page = annotator.annotate(wire.annotation, { color: wire.color, text: wire.text });
        if (page !== null) changed = [page];
        break;
      }
      case 'delete': {
        if (annotator.pickedObject) {
          changed = annotator.deleteObject();
          break;
        }
        if (annotator.picked && !annotator.picked.runs) {
          changed = annotator.deleteText();
          break;
        }
        const page = annotator.deleteSelected();
        if (page !== null) changed = [page];
        break;
      }
      case 'setFields': {
        const before = new Map(annotator.fields.map((f) => [f.id, f]));
        annotator.setFields(
          wire.fields.map((f) => this.fieldFromWire(f, before)),
          wire.merge,
        );
        break;
      }
      case 'pdfPick': {
        const index = this.pdfPages.findIndex((p) => p.id === wire.page);
        if (index < 0) break;
        // Characters added to the text may need faces that stand in for the file's fonts: load them first.
        void this.pickText(annotator, index, wire.x, wire.y);
        return;
      }
      case 'pdfText':
        changed = annotator.setPickedText(wire.text);
        break;
      case 'pdfPutDown':
        changed = annotator.deselect();
        break;
      case 'pdfStyle':
        // The font file the new look needs is fetched first: setting text in it is not asynchronous.
        void this.styleText(annotator, wire);
        return;
      case 'pdfMoveText': {
        const at = annotator.picked;
        if (!at) break;
        const { view } = this.pdf!;
        const [ax, ay] = view.toUser(at.page, 0, 0);
        const [bx, by] = view.toUser(at.page, wire.dx, wire.dy);
        changed = annotator.moveText(bx - ax, by - ay);
        break;
      }
      case 'pdfMove': {
        const o = annotator.pickedObject;
        if (o) changed = annotator.moveObject(this.userBox(o.page, wire.box));
        break;
      }
      case 'pdfShape': {
        const stroke = wire.stroke === undefined ? undefined : wire.stroke === null ? null : parseHex(wire.stroke);
        const fill = wire.fill === undefined ? undefined : wire.fill === null ? null : parseHex(wire.fill);
        changed = annotator.setShapeStyle({ ...(stroke !== undefined && { stroke }), ...(fill !== undefined && { fill }), ...(wire.width !== undefined && { width: wire.width }) });
        break;
      }
      case 'pdfAddShape': {
        const index = this.pdfPages.findIndex((p) => p.id === wire.page);
        if (index < 0) break;
        if (wire.shape === 'redact') {
          changed = annotator.addRedaction(index, this.userBox(index, wire.box));
          break;
        }
        const white = wire.shape === 'whiteout';
        const shape = wire.shape === 'whiteout' ? 'rect' : wire.shape;
        const mark = shape === 'check' || shape === 'cross';
        const look = white ? { stroke: null, fill: [1, 1, 1] as [number, number, number], width: 0 } : { stroke: [0, 0, 0] as [number, number, number], fill: null, width: mark ? 2 : 1.5 };
        changed = annotator.addShape(index, shape, this.userBox(index, wire.box), { ...look, flip: shape === 'line' && this.rises(index, wire.box, wire.flip ?? false) });
        break;
      }
      case 'pdfAddImage': {
        const index = this.pdfPages.findIndex((p) => p.id === wire.page);
        if (index >= 0) changed = annotator.addImage(index, this.userBox(index, wire.box), wire.data);
        break;
      }
      case 'pdfAddText': {
        const index = this.pdfPages.findIndex((p) => p.id === wire.page);
        if (index < 0) break;
        const { view } = this.pdf!;
        const [ux, uy] = view.toUser(index, wire.x, wire.y);
        changed = annotator.addTextBox(index, ux, uy, wire.text);
        break;
      }
      case 'pdfPageOp':
        void this.pdfPageOp(annotator, wire);
        return;
      case 'undo':
        changed = annotator.undo();
        if (annotator.reopen) return void this.reopenPdf(annotator);
        break;
      case 'redo':
        changed = annotator.redo();
        if (annotator.reopen) return void this.reopenPdf(annotator);
        break;
      default:
        return;
    }
    if (changed.length) this.relayoutPdf(changed);
    else this.sendSelection();
  }

  /**
   * Whether a line in a box on the page (from its top left to its bottom right, or from its bottom left to its top right if
   * `rising`) runs from the top left to the bottom right of the box in user space, which is what a shape's `flip` says.
   */
  private rises(page: number, box: WireBox, rising: boolean): boolean {
    const { view } = this.pdf!;
    const [sx, sy] = view.toUser(page, box.x, rising ? box.y + box.height : box.y);
    const [ex, ey] = view.toUser(page, box.x + box.width, rising ? box.y : box.y + box.height);
    return (ex - sx) * (ey - sy) < 0;
  }

  private async styleText(annotator: PdfAnnotator, wire: Extract<WireCommand, { kind: 'pdfStyle' }>): Promise<void> {
    const picked = annotator.picked;
    if (!picked || !this.pdf) return;
    const family = wire.font ?? picked.style.family;
    await this.pdf.view.loadFont(family, wire.bold ?? picked.style.bold, wire.italic ?? picked.style.italic);
    if (this.closed || annotator.picked !== picked) return;
    const color = wire.color ? parseHex(wire.color) : undefined;
    const changed = annotator.setTextStyle({ font: wire.font, bold: wire.bold, italic: wire.italic, size: wire.size, ...(color && { color }) });
    if (changed.length) this.relayoutPdf([...new Set(changed)]);
    else this.sendSelection();
  }

  /** Lays every page of the PDF out again (its pages changed), and sends them. */
  private async relayoutAllPdf(): Promise<void> {
    this.pdfPages = [];
    this.pending = [];
    await this.pumpPdf();
    if (!this.closed) this.sendSelection();
  }

  /**
   * Deletes, turns, moves, copies or adds a page. The change is made to a new file, with the edits, markup and fields
   * as they are now written into it; the old one stays in the history, so undo can go back to it.
   */
  private async pdfPageOp(annotator: PdfAnnotator, wire: Extract<WireCommand, { kind: 'pdfPageOp' }>): Promise<void> {
    const index = this.pdfPages.findIndex((p) => p.id === wire.page);
    const original = this.original;
    if (index < 0 || !original || !this.pdf) return;
    try {
      const { PdfDocument, openPdfView } = await import('../formats/handlers/pdf.ts');
      const doc = PdfDocument.load(await annotatedPdf(original, currentExtensions(this)));
      const page = doc.pages[index];
      switch (wire.op) {
        case 'delete':
          if (doc.pageCount < 2) return;
          doc.removePage(index);
          break;
        case 'rotateLeft':
        case 'rotateRight':
          page.rotation = page.rotation + (wire.op === 'rotateRight' ? 90 : -90);
          break;
        case 'moveUp':
          if (index === 0) return;
          doc.movePage(index, index - 1);
          break;
        case 'moveDown':
          if (index >= doc.pageCount - 1) return;
          doc.movePage(index, index + 1);
          break;
        case 'duplicate':
          doc.copyPages(doc, [index], index + 1);
          break;
        case 'insert': {
          const [x0, y0, x1, y1] = page.mediaBox;
          doc.addPage([x1 - x0, y1 - y0], index + 1);
          break;
        }
      }
      const bytes = await doc.save();
      const fonts = await fontsReady;
      const view = await openPdfView(bytes, fonts, { editFonts: await editFontsFor(fonts) });
      if (this.closed || this.original !== original) return;
      annotator.replaceView(view, bytes);
      this.original = bytes;
      this.pdf = { view, bytes };
      this.edited = true;
      await this.relayoutAllPdf();
    } catch (e) {
      console.error(e);
      post({ type: 'error', doc: this.doc, message: (e as Error).message });
    }
  }

  /** Undo or redo went across a page operation: opens the file that came before (or after) it, with its layers. */
  private async reopenPdf(annotator: PdfAnnotator): Promise<void> {
    const back = annotator.reopen;
    if (!back || !this.pdf) return;
    try {
      const { openPdfView } = await import('../formats/handlers/pdf.ts');
      const { annotations, fields, edits } = back.layers;
      const fonts = await fontsReady;
      const view = await openPdfView(back.original, fonts, { annotations, fields, edits, editFonts: await editFontsFor(fonts) });
      if (this.closed) return;
      annotator.attach(view, back.original, back.layers);
      this.original = back.original;
      this.pdf = { view, bytes: back.original };
      this.edited = true;
      await this.relayoutAllPdf();
    } catch (e) {
      console.error(e);
      post({ type: 'error', doc: this.doc, message: (e as Error).message });
    }
  }

  /** After something added was picked: the faces its text may need are loaded, then the pages are laid out again. */
  private async afterPick(annotator: PdfAnnotator, pages: number[]): Promise<void> {
    const picked = annotator.picked;
    if (picked) await this.pdf!.view.ensureFonts(picked.style.serif, picked.style.mono);
    if (this.closed) return;
    const changed = [...new Set([...pages, ...(picked ? [picked.page] : [])])];
    if (changed.length) this.relayoutPdf(changed);
    else this.sendSelection();
  }

  private async pickText(annotator: PdfAnnotator, index: number, x: number, y: number): Promise<void> {
    const before = annotator.picked;
    let changed = annotator.pickText(index, x, y);
    const picked = annotator.picked;
    if (picked && picked !== before) {
      await this.pdf!.view.ensureFonts(picked.style.serif, picked.style.mono);
      if (this.closed || annotator.picked !== picked) return;
      changed = [...changed, picked.page];
    }
    if (changed.length) this.relayoutPdf([...new Set(changed)]);
    else this.sendSelection();
  }

  // --- Collaboration ---------------------------------------------------------------------

  private toRoom(message: RoomClientMessage, transfer: Transferable[] = []): void {
    this.room?.port.postMessage(message, transfer);
  }

  /** Joins the room: resolves with the room's document and its log so far. */
  join(room: Extract<RoomOptions, { kind: 'dev' }>, client: string, snapshot: ArrayBuffer): Promise<Extract<RoomServerMessage, { type: 'joined' }>> {
    this.room = room;
    room.port.onmessage = (event: MessageEvent<RoomServerMessage>) => this.fromRoom(event.data);
    return new Promise((resolve) => {
      this.joined = resolve;
      this.toRoom({ type: 'join', room: room.name, client, snapshot }, [snapshot]);
    });
  }

  private fromRoom(message: RoomServerMessage): void {
    try {
      this.handleRoom(message);
    } catch (e) {
      console.error(e);
    }
  }

  private handleRoom(message: RoomServerMessage): void {
    if (this.closed) return;
    if (message.type === 'joined') {
      this.count = message.people;
      this.joined?.(message);
      return;
    }
    if (!this.editor) {
      this.backlog.push(message);
      return;
    }
    switch (message.type) {
      case 'transactions': {
        const { change } = this.editor.receive(message);
        if (change) {
          // Other people's carets move with the text too.
          for (const person of this.people.values()) if (person.selection) person.selection = Replica.mapSelection(person.selection, change.mapping);
          void this.pump();
        }
        this.status();
        break;
      }
      case 'presence':
        if (message.selection) this.people.set(message.client, { name: message.name, color: message.color, selection: message.selection, pointer: null });
        else this.people.delete(message.client);
        this.sendSelection();
        break;
      case 'people':
        this.count = message.count;
        this.status();
        break;
    }
  }

  /** Handles room messages that arrived while the document was being set up. */
  ready(): void {
    const backlog = this.backlog;
    this.backlog = [];
    for (const message of backlog) this.fromRoom(message);
    this.status();
  }

  private sendPresence(): void {
    if ((!this.room && !this.net) || !this.editor) return;
    const selection = this.editor.selectionIds;
    const key = JSON.stringify(selection);
    if (key === this.lastPresence) return;
    this.lastPresence = key;
    if (this.net) this.net.presence(selection);
    else this.toRoom({ type: 'presence', name: this.room!.user, color: this.room!.color, selection });
  }

  private status(): void {
    const sync = this.replica?.sync;
    if (this.room && sync) post({ type: 'room', doc: this.doc, people: this.count, ...sync });
    if (this.net) this.postRoomState();
  }

  leave(): void {
    this.toRoom({ type: 'leave' });
    this.net?.leave();
  }

  /**
   * Joins the room for a document that was already open (a new one once uploaded, or a saved one
   * shown before it was known who is signed in). When someone else is editing, the room's document
   * would replace this one: if nothing was typed here the page reopens it from the room; otherwise
   * it carries on unshared and is merged as a separate copy later.
   */
  async joinLate(room: Extract<RoomOptions, { kind: 'network' }>): Promise<void> {
    if (this.net || this.room || this.format !== 'docx' || !this.replica || !this.editor) return;
    const start = await this.joinNetwork(room, this.replica.clientId);
    if (this.closed) {
      // Another document was opened while joining: nobody is left to use this room.
      (this.net as RoomClient | null)?.leave();
      this.net = null;
      return;
    }
    if (!start) return;
    if (start.kind === 'own') this.net!.ready(start);
    else {
      this.net!.leave();
      this.net = null;
      // Nothing typed here yet: the page reopens the document from the room's copy instead.
      if (!this.edited) post({ type: 'roomReplace', doc: this.doc });
    }
  }

  // --- The multiplayer server ---------------------------------------------------------

  /** Viewers, and anyone whose connection to the room is gone, can look but not edit. */
  get readOnly(): boolean {
    return this.net !== null && !this.net.canEdit;
  }

  private postPointers(): void {
    const pointers = [];
    for (const person of this.people.values()) if (person.pointer) pointers.push({ ...person.pointer, color: person.color, name: person.name });
    post({ type: 'pointers', doc: this.doc, pointers });
  }

  /** This user's mouse, for the other people in the room. */
  sendPointer(pointer: Pointer | null): void {
    this.net?.pointer(pointer);
  }

  private postRoomState(): void {
    const net = this.net;
    if (!net) return;
    const { mode, role, people } = net.state;
    post({ type: 'roomState', doc: this.doc, mode, role, people: people.map(({ name, color }) => ({ name, color })), unconfirmed: this.replica?.sync?.unconfirmed ?? 0 });
  }

  /**
   * Joins the multiplayer server's room for this cloud document. Returns where the document comes
   * from, or null when there is no room to join (signed out, offline, no access, local-only server):
   * the document is then edited as a plain one and saved as usual.
   */
  async joinNetwork(room: Extract<RoomOptions, { kind: 'network' }>, clientId: string): Promise<RoomStart | null> {
    this.clientId = clientId;
    const docId = room.docId;
    const net = new RoomClient({
      client: clientId,
      name: room.user,
      color: room.color,
      host: this.roomHost(),
      connect: () => new WebSocket(`${self.location.protocol === 'https:' ? 'wss' : 'ws'}://${self.location.host}/api/rooms/${docId}`) as unknown as SocketLike,
      fetchDocument: async () => {
        const response = await fetch(`/api/rooms/${docId}/document`);
        if (!response.ok) throw new Error(`could not fetch the room's document (${response.status})`);
        return {
          bytes: new Uint8Array(await response.arrayBuffer()),
          epoch: Number(response.headers.get('x-room-epoch')),
          version: Number(response.headers.get('x-room-version')),
        };
      },
      upload: async (bytes) => {
        const response = await fetch(`/api/documents/${docId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
          body: bytes as Uint8Array<ArrayBuffer>,
        });
        if (!response.ok) throw new Error(`upload failed (${response.status})`);
      },
    });
    try {
      const start = await net.join();
      this.net = net;
      return start;
    } catch (error) {
      console.warn('no multiplayer room:', (error as Error).message);
      net.leave();
      return null;
    }
  }

  /** What the room needs from this document. */
  private roomHost(): RoomHost {
    return {
      serialize: () => this.document!.write(),
      // Commands made while the document is being handed over wait for the handover.
      freeze: (until) => this.later(() => until.then(() => {}, () => {})),
      connect: (send, version) => this.replica!.connect(send, version),
      disconnect: () => this.replica?.disconnect(),
      receive: (message) => {
        const { change } = this.editor!.receive(message);
        if (change) {
          // Other people's carets move with the text too.
          for (const person of this.people.values()) if (person.selection) person.selection = Replica.mapSelection(person.selection, change.mapping);
          this.edited = true;
          post({ type: 'remoteEdit', doc: this.doc });
          void this.pump();
        }
        this.status();
      },
      sync: () => this.replica?.sync ?? null,
      resubmit: () => this.replica?.resubmit(),
      changed: () => {
        this.postRoomState();
        this.sendSelection();
      },
      people: (list) => {
        this.people.clear();
        for (const p of list) if (p.client !== this.clientId) this.people.set(p.client, { name: p.name, color: p.color, selection: p.selection, pointer: p.pointer });
        this.postPointers();
        this.sendSelection();
      },
      pointers: (list) => {
        for (const p of list) {
          const person = this.people.get(p.client);
          if (person) person.pointer = p.pointer;
        }
        this.postPointers();
      },
    };
  }

  /** A picture at the caret, no wider than the page's text. Not in a room: the others would have no bytes for it. */
  insertImage(bytes: Uint8Array, ext: string, width: number, height: number, description?: string): void {
    const document = this.document;
    if (!document || this.readOnly || this.room || this.net || this.pdf) return;
    const { pageSize, margins } = document.section;
    const most = ((pageSize?.w ?? 12240) - (margins?.left ?? 1440) - (margins?.right ?? 1440)) * 635;
    if (most > 0 && width > most) {
      height = Math.round((height * most) / width);
      width = most;
    }
    const image = document.addImage(bytes, ext);
    this.apply({ kind: 'insertContent', content: [{ kind: 'run', properties: {}, content: [{ kind: 'drawing', inline: true, width, height, image, ...(description && { description }) }], attrs: {} }] });
  }

  /** Commands waiting for fonts a formatting command needs; later ones queue behind it. */
  private waiting: Promise<void> | null = null;

  command(wire: WireCommand): void {
    if (this.waiting) return this.later(() => this.runCommand(wire));
    const done = this.runCommand(wire);
    if (done) this.later(() => done);
  }

  /** One of the assistant's tools, run on this document (see agentTools.ts). Settles with its answer once its edits have taken effect. */
  async agent(name: string, args: string): Promise<string> {
    const editor = this.editor;
    if (!editor || this.closed || this.annotator) return 'Error: this document has no text to work with.';
    return runAgentTool(
      {
        editor,
        readOnly: this.readOnly || this.format === 'pdf',
        run: async (wire) => {
          this.command(wire);
          while (this.waiting) await this.waiting;
        },
        format: () => this.formats!.read(...editor.ordered(), editor.paragraphs(), editor.pending),
      },
      name,
      args,
    );
  }

  /** Formatting from the menus and toolbars. One that starts using a font loads its faces first. */
  private applyFormat(action: FormatAction): void | Promise<void> {
    const { editor, session } = this;
    if (!editor || !session || this.annotator || this.readOnly) return;
    if (action.kind === 'formatPainter') {
      this.painter = this.painter ? null : this.pickUpFormat(editor);
      this.sendSelection();
      return;
    }
    const fonts = new Set<string>();
    const command = formatCommand(action, editor, this.formats!.read(...editor.ordered(), editor.paragraphs(), editor.pending), fonts);
    if (!command) return;
    if (fonts.size) return session.ensureFonts(fonts).then(() => this.apply(command));
    this.apply(command);
  }

  /** The formatting at the selection: its text's, and its paragraphs' when it covers a whole paragraph. */
  private pickUpFormat(editor: Editor): NonNullable<OpenDocument['painter']> {
    const [start, end] = editor.ordered();
    const run = structuredClone(runPropertiesAt(start.paragraph, start.offset) ?? {});
    const whole = !editor.collapsed && start.offset === 0 && (end.paragraph !== start.paragraph || end.offset >= paragraphLength(start.paragraph));
    return { run, paragraph: whole ? structuredClone(start.paragraph.properties) : null };
  }

  /** Paints the selection with what the Format Painter picked up, once, if something is selected. */
  private applyPainter(): void {
    const editor = this.editor;
    const painter = this.painter;
    if (!editor || !painter || editor.collapsed || this.annotator || this.readOnly) return;
    this.painter = null;
    // Each run takes exactly the picked-up formatting: what it had of its own goes.
    this.apply({
      kind: 'formatText',
      format: (run) => {
        const format: RunFormat = {};
        for (const key of Object.keys(run) as (keyof RunProperties)[]) if (!(key in painter.run)) format[key] = null;
        for (const key of Object.keys(painter.run) as (keyof RunProperties)[]) (format as Record<string, unknown>)[key] = structuredClone(painter.run[key]);
        return format;
      },
    });
    const source = painter.paragraph;
    if (source) {
      this.apply({
        kind: 'formatParagraphs',
        change: () => ({ style: source.style, justification: source.justification, spacing: source.spacing && { ...source.spacing }, indent: source.indent && { ...source.indent } }),
      });
    }
  }

  /** Pastes formatted text (the clipboard's HTML) at the caret, or its plain text if the HTML can't be used. */
  private async pasteHtml(html: string, text: string): Promise<void> {
    const { editor, session, document } = this;
    if (!editor || !session || !document || this.annotator || this.readOnly) return;
    let pasted: Awaited<ReturnType<typeof htmlToPaste>> = null;
    try {
      pasted = await htmlToPaste(html, document);
      if (pasted?.fonts.size) await session.ensureFonts(pasted.fonts);
    } catch {
      pasted = null;
    }
    if (this.closed) return;
    if (pasted) this.apply({ kind: 'pasteContent', blocks: pasted.blocks, define: pasted.define });
    else if (text) this.apply({ kind: 'insertText', text });
    this.reveal = true;
  }

  /** Counts the words and the rest of the selection, or of the whole document if nothing is selected. */
  private countWords(whole: boolean): void {
    const { editor, session } = this;
    if (!editor || !session || this.closed || this.annotator) this.stats = null;
    else {
      const list = editor.paragraphs();
      const [start, end] = editor.ordered();
      const selection = !editor.collapsed && !whole;
      const first = selection ? list.indexOf(start.paragraph) : 0;
      const last = selection ? list.indexOf(end.paragraph) : list.length - 1;
      const texts: string[] = [];
      for (let k = first; k <= last; k++) {
        const p = list[k];
        const from = selection && k === first ? start.offset : 0;
        const to = selection && k === last ? end.offset : Infinity;
        texts.push(plainText(p, from, to));
      }
      // Lines and pages: those of the paragraphs counted, and (for a selection) that the selected text touches.
      const inRange = new Set(list.slice(first, last + 1));
      let lines = 0;
      const pagesUsed = new Set<PageLayout>();
      for (const page of session.displayPages) {
        for (const line of page.lines) {
          if (!inRange.has(line.paragraph)) continue;
          if (selection) {
            const model = (offset: number) => toModel(line.spans, offset);
            if (line.paragraph === start.paragraph && model(line.end) <= start.offset && line.end > line.start) continue;
            if (line.paragraph === end.paragraph && model(line.start) >= end.offset && end.offset > 0) continue;
          }
          lines++;
          pagesUsed.add(page);
        }
      }
      this.stats = { ...countText(texts), pages: selection ? pagesUsed.size : session.displayPages.length, lines, selection };
    }
    this.sendSelection();
  }

  /** The squiggles for the pages shown: red under misspelled words, green under grammar mistakes. */
  private spellMarks(editor: Editor): Float64Array {
    if (!live.spelling && !live.grammar) return new Float64Array(0);
    const dictionary = loadedDictionary;
    if (!dictionary) {
      if (!this.loadingMarks) {
        this.loadingMarks = true;
        loadDictionary()
          .then(() => this.sendSelection())
          .catch(() => undefined)
          .finally(() => (this.loadingMarks = false));
      }
      return new Float64Array(0);
    }
    const [start, end] = editor.ordered();
    const typing = start.paragraph === end.paragraph && start.offset === end.offset ? start : null;
    const marks = editor.marks((paragraph) =>
      issuesOf(paragraph, dictionary)
        // The word being typed isn't marked until the caret leaves it.
        .filter((i) => !(typing && typing.paragraph === paragraph && i.start < typing.offset && typing.offset <= i.end))
        .map((i) => ({ start: i.start, end: i.end, kind: i.kind === 'spelling' ? 0 : 1 })),
    );
    const out = new Float64Array(marks.length * 6);
    marks.forEach((m, i) => out.set([m.page.id, m.x, m.y, m.width, m.height, m.kind], i * 6));
    return out;
  }

  /** The address of the link under a point on a page (null when there is none, or the document isn't text). */
  linkAt(pageId: number, x: number, y: number): string | null {
    const page = this.session?.displayPages.find((p) => p.id === pageId);
    return this.editor && page && !this.closed && !this.annotator ? this.editor.linkUnder(page, x, y) : null;
  }

  /** Right click: selects the mistake under the point and reports it for the menu (nothing, if there is none). */
  private async spellAt(pageId: number, x: number, y: number): Promise<void> {
    const editor = this.editor;
    const session = this.session;
    if (!editor || !session || this.closed || this.annotator) return;
    const dictionary = await loadDictionary();
    const page = session.displayPages.find((p) => p.id === pageId);
    const hit = page && editor.hitTest(page, x, y);
    this.spell = { issue: null, menu: true };
    if (hit) {
      const issue = issuesOf(hit.paragraph, dictionary).find((i) => i.start <= hit.offset && hit.offset <= i.end);
      if (issue) {
        this.spell = { issue: describeIssue(paragraphText(hit.paragraph), issue, dictionary), menu: true };
        editor.apply({ kind: 'select', paragraph: editor.paragraphs().indexOf(hit.paragraph), from: issue.start, to: issue.end });
      }
    }
    this.reveal = false;
    this.sendSelection();
  }

  /** Selects the next spelling or grammar mistake at or after the place `from` says, and reports it. */
  private async spellNext(from: 'documentStart' | 'selectionStart' | 'selectionEnd', grammar: boolean): Promise<void> {
    const editor = this.editor;
    if (!editor || this.closed || this.annotator) return;
    const dictionary = await loadDictionary();
    const list = editor.paragraphs();
    const [start, end] = editor.ordered();
    const origin = from === 'documentStart' ? { paragraph: 0, offset: 0 } : { paragraph: Math.max(list.indexOf(from === 'selectionStart' ? start.paragraph : end.paragraph), 0), offset: (from === 'selectionStart' ? start : end).offset };
    this.spell = { issue: null };
    for (let k = origin.paragraph; k < list.length; k++) {
      const text = paragraphText(list[k]);
      const issue = findIssues(text, { dictionary, grammar, ignoredRules: spelling.rules }).find((i) => k > origin.paragraph || i.start >= origin.offset);
      if (!issue) continue;
      this.spell = { issue: describeIssue(text, issue, dictionary) };
      editor.apply({ kind: 'select', paragraph: k, from: issue.start, to: issue.end });
      break;
    }
    this.reveal = true;
    this.sendSelection();
  }

  private later(task: () => void | Promise<void>): void {
    const next = (this.waiting ?? Promise.resolve()).then(task).catch((e: unknown) => console.error(e));
    this.waiting = next;
    void next.then(() => {
      if (this.waiting === next) this.waiting = null;
    });
  }

  /** Applies an editor command made here (formatting). */
  private apply(command: Command): void {
    const editor = this.editor;
    if (!editor || this.closed || this.format === 'pdf' || this.readOnly) return;
    this.reveal = false;
    this.commandAt = performance.now();
    if (editor.apply(command).edited) {
      this.edited = true;
      void this.pump();
      this.status();
    } else this.sendSelection();
  }

  private runCommand(wire: WireCommand, cjkReady = false, mathReady = false): void | Promise<void> {
    if (wire.kind === 'format') return this.applyFormat(wire.action);
    if (wire.kind === 'applyPainter') return this.applyPainter();
    if (wire.kind === 'countWords') return this.countWords(wire.whole ?? false);
    if (wire.kind === 'pasteHtml') return this.pasteHtml(wire.html, wire.text);
    if (wire.kind === 'getProperties') {
      this.props = { ...this.document?.properties };
      return this.sendSelection();
    }
    if (wire.kind === 'spellWords') return acceptSpelling(wire.words ?? [], wire.rules ?? []).then(() => this.sendSelection());
    if (wire.kind === 'spellCheck') {
      live.spelling = wire.spelling;
      live.grammar = wire.grammar;
      return acceptSpelling(wire.words ?? [], []).then(() => this.sendSelection());
    }
    if (wire.kind === 'spellAt') return this.spellAt(wire.page, wire.x, wire.y);
    if (wire.kind === 'spellNext') return this.spellNext(wire.from, wire.grammar);
    if (this.annotator) return this.pdfCommand(this.annotator, wire);
    if (isPdfCommand(wire)) return;
    const editor = this.editor;
    const session = this.session;
    if (!editor || !session) return;
    // An equation needs the math font before it is laid out.
    if (!mathReady && commandHasMath(wire)) return session.ensureMath().then(() => this.runCommand(wire, cjkReady, true));
    // Typed, pasted or replaced Japanese and Chinese text needs its font pages before it is laid out.
    if (!cjkReady && !this.annotator) {
      const text = commandText(wire);
      if (text && /[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7ff\uf900-\ufaff\uff00-\uffef]/.test(text)) return session.ensureCjk(text).then(() => this.runCommand(wire, true, mathReady));
    }
    this.reveal = wire.kind !== 'pointer';
    this.commandAt = performance.now();
    let edited: boolean;
    // Shown as PDF: selecting and moving only.
    if ((this.format === 'pdf' || this.readOnly) && !VIEW_COMMANDS.has(wire.kind)) return;
    if (wire.kind === 'undo') edited = editor.undo().edited;
    else if (wire.kind === 'redo') edited = editor.redo().edited;
    else {
      let command: Command;
      if (wire.kind === 'pointer') {
        const page = session.displayPages.find((p) => p.id === wire.page) ?? session.pages.find((p) => p.id === wire.page);
        if (!page) return;
        command = { ...wire, page };
      } else command = wire;
      const result = editor.apply(command);
      edited = result.edited;
      if (command.kind === 'find' || command.kind === 'replaceAll') this.search = { found: result.found, replaced: result.replaced };
    }
    // Edits send the selection once the changed pages are laid out.
    if (edited) {
      this.edited = true;
      void this.pump();
      this.status();
    } else this.sendSelection();
  }
}

/** Words the user added to the dictionary or chose to ignore, and grammar rules to ignore: for every document. */
const spelling = { words: new Set<string>(), rules: new Set<string>() };
/** What is underlined as the user types. */
const live = { spelling: true, grammar: true };
let dictionaryLoad: Promise<Dictionary> | null = null;
let loadedDictionary: Dictionary | null = null;
/** Changes when what counts as a mistake does, so checked paragraphs are checked again. */
let spellVersion = 0;
const checked = new WeakMap<object, { text: string; version: number; issues: TextIssue[] }>();

/** What is wrong in a paragraph: kept until its text (or what counts as wrong) changes. */
function issuesOf(paragraph: Parameters<typeof paragraphText>[0], dictionary: Dictionary): TextIssue[] {
  const text = paragraphText(paragraph);
  const known = checked.get(paragraph);
  if (known && known.text === text && known.version === spellVersion) return known.issues;
  const issues = findIssues(text, { dictionary, grammar: live.grammar, ignoredRules: spelling.rules }).filter((i) => live.spelling || i.kind !== 'spelling');
  checked.set(paragraph, { text, version: spellVersion, issues });
  return issues;
}

/** An issue with the sentence around it, and its suggestions, for the dialog or the menu. */
function describeIssue(text: string, issue: TextIssue, dictionary: Dictionary): SpellIssue {
  let sentenceStart = 0;
  for (const m of text.slice(0, issue.start).matchAll(/[.!?]["'”’)]*\s+/g)) sentenceStart = m.index + m[0].length;
  const before = text.slice(Math.max(sentenceStart, issue.start - 200), issue.start);
  const rest = /[.!?]["'”’)]*(?=\s|$)/.exec(text.slice(issue.end));
  const after = text.slice(issue.end, Math.min(rest ? issue.end + rest.index + rest[0].length : text.length, issue.end + 200));
  return { kind: issue.kind, before, text: issue.text, after, message: issue.message, suggestions: issue.kind === 'spelling' ? dictionary.suggest(issue.text) : issue.suggestions, rule: issue.rule };
}

/** The English dictionary, read the first time something is checked. */
function loadDictionary(): Promise<Dictionary> {
  dictionaryLoad ??= Promise.all([fetch(`${DICTIONARY_BASE}en_US.aff`), fetch(`${DICTIONARY_BASE}en_US.dic`)])
    .then(async ([aff, dic]) => {
      if (!aff.ok || !dic.ok) throw new Error('the dictionary could not be loaded');
      const dictionary = Dictionary.parse(await aff.text(), await dic.text());
      dictionary.accept(...spelling.words);
      loadedDictionary = dictionary;
      return dictionary;
    })
    .catch((error: unknown) => {
      // Try again next time.
      dictionaryLoad = null;
      throw error;
    });
  return dictionaryLoad;
}

/** Words to treat as spelled correctly and grammar rules to leave out, from now on. */
async function acceptSpelling(words: string[], rules: string[]): Promise<void> {
  for (const word of words) spelling.words.add(word);
  for (const rule of rules) spelling.rules.add(rule);
  spellVersion++;
  if (dictionaryLoad) (await dictionaryLoad).accept(...words);
}

let current: OpenDocument | null = null;

async function open(doc: number, source: DocumentSource, requestedRoom?: RoomOptions): Promise<void> {
  current?.leave();
  current?.controller.abort();
  const entry = new OpenDocument(doc);
  current = entry;
  try {
    const fonts = await fontsReady;
    const t0 = performance.now();
    const loaded = await load(source, fonts);
    if (entry.closed) return;
    entry.format = loaded.lens;
    entry.origin = loaded.origin;
    entry.extensions = loaded.extensions;
    entry.original = loaded.original;
    entry.pagesCurrent = loaded.pagesCurrent;
    const name = loaded.name;
    // Shown as PDF: the original's own pages, even when its text has since been edited as
    // something else (the page is told, to say that the edits aren't on them).
    if (loaded.lens === 'pdf' && loaded.original) {
      const { openPdfView, PdfAnnotator } = await import('../formats/handlers/pdf.ts');
      const view = await openPdfView(loaded.original, fonts, { annotations: loaded.extensions.pdf?.annotations, fields: loaded.extensions.pdf?.fields, edits: loaded.extensions.pdf?.edits, editFonts: await editFontsFor(fonts) });
      const readMs = performance.now() - t0;
      if (entry.closed) return;
      entry.document = loaded.document; // kept as it is, for saving
      entry.pdf = { view, bytes: loaded.original };
      entry.annotator = new PdfAnnotator(view, undefined, loaded.original);
      post({ type: 'opened', doc, name, format: 'pdf', annotating: true, outdated: !!loaded.document && !loaded.pagesCurrent });
      const bodyMs = await entry.pumpPdf();
      if (entry.closed) return;
      post({ type: 'done', doc, pages: view.pageCount, timings: { read: readMs, fonts: 0, body: bodyMs, headers: 0 } });
      return;
    }
    // A PDF edited as anything else is reflowed into a flowing document the first time.
    let document = loaded.document ?? (await reflow(loaded.original!, loaded.extensions));
    // Rooms share a .docx, so only a Word document can be in one.
    const room = entry.format === 'docx' ? requestedRoom : undefined;
    const readMs = performance.now() - t0;
    if (entry.closed) return;
    const clientId = crypto.randomUUID().slice(0, 8);
    let log: Transaction[] = [];
    let start: RoomStart | null = null;
    if (room?.kind === 'network') {
      start = await entry.joinNetwork(room, clientId);
      if (entry.closed) return;
      // Someone else is already editing: everyone starts from the room's copy, not ours.
      if (start?.kind === 'room') document = await WordDocument.read(start.bytes);
    } else if (room) {
      // Everyone starts from the room's copy (ours, if we're first): the same bytes, read the
      // same way, then the log so far.
      const joined = await entry.join(room, clientId, (await document.write()).slice().buffer);
      if (entry.closed) return;
      document = await WordDocument.read(new Uint8Array(joined.snapshot));
      log = joined.transactions;
    }
    // Operations need paragraph ids and normalized content: set up before layout sees the document.
    const replica = new Replica(document, { clientId });
    for (const tx of log) replica.engine.apply(tx.ops);
    if (room?.kind === 'dev') replica.connect((message) => room.port.postMessage(message satisfies RoomClientMessage), log.length);
    const session = await LayoutSession.create(document, fonts);
    if (entry.closed) return;
    entry.document = document;
    entry.replica = replica;
    entry.session = session;
    entry.editor = new Editor(replica, session);
    entry.formats = new FormatReader(document);
    entry.ready();
    if (start) entry.net!.ready(start);
    post({ type: 'opened', doc, name, format: entry.format, annotating: false, outdated: false });
    await entry.pump();
    if (entry.closed) return;
    post({ type: 'done', doc, pages: session.pages.length, timings: { read: readMs, ...session.timings } });
  } catch (e) {
    if (entry.closed) return;
    console.error(e);
    post({ type: 'error', doc, message: (e as Error).message });
  }
}

async function media(doc: number, request: number, part: string): Promise<void> {
  let bytes: ArrayBuffer | null = null;
  try {
    if (current?.doc === doc && current.pdf) bytes = (await current.pdf.view.media(part))?.slice().buffer ?? null;
    else if (current?.doc === doc && current.document) bytes = (await current.document.media(part)).slice().buffer;
  } catch {
    bytes = null;
  }
  post({ type: 'media', request, bytes }, bytes ? [bytes] : []);
}

/** A PDF reflowed into a flowing document, its markup annotations carried into the text. */
async function reflow(original: Uint8Array, extensions: Extensions): Promise<WordDocument> {
  const { pdfToDocument, markupToDocument, PdfDocument, readAnnotations } = await import('../formats/handlers/pdf.ts');
  const document = await pdfToDocument(original, { edits: extensions.pdf?.edits });
  const pdf = PdfDocument.load(original);
  markupToDocument(document, pdf, extensions.pdf?.annotations ?? readAnnotations(pdf));
  return document;
}

/** The font files edits to a PDF need, fetched as asked for (see formats/pdfFonts.ts). */
async function editFontsFor(fonts: FontSet) {
  const { EditFonts } = await import('../formats/handlers/pdf.ts');
  return new EditFonts(fonts, async (path) => new Uint8Array(await (await fetchOk(FONT_BASE + path)).arrayBuffer()));
}

/** The document's extensions, with the PDF's annotations and form fields as they are now when its pages are shown. */
function currentExtensions(open: OpenDocument): Extensions {
  if (!open.annotator) return open.extensions;
  return { ...open.extensions, pdf: { annotations: [...open.annotator.annotations], fields: [...open.annotator.fields], edits: [...open.annotator.edits] } };
}

/**
 * The original PDF with the document's annotations, form fields and edits written in. Markup and
 * fields go in as an incremental update (the original bytes, then the changes); edits to the page's
 * own content are written in full, so that what they removed isn't left in the file behind them.
 * The original itself when there is nothing to write.
 */
async function annotatedPdf(original: Uint8Array, extensions: Extensions): Promise<Uint8Array> {
  const { annotations, fields, edits } = extensions.pdf ?? {};
  if (!annotations && !fields && !edits?.length) return original.slice();
  const { PdfDocument, applyAnnotations, applyEdits, applyFields } = await import('../formats/handlers/pdf.ts');
  const doc = PdfDocument.load(original);
  if (annotations) applyAnnotations(doc, annotations);
  if (fields) applyFields(doc, fields);
  if (edits?.length) {
    // Fonts the edits set text in are written into the file, from their font files.
    const editFonts = await editFontsFor(await fontsReady);
    await editFonts.ensure(edits);
    applyEdits(doc, edits, editFonts.options);
    return doc.save();
  }
  return doc.save({ incremental: true });
}

/** The whole open document as a .wdoc, to be edited as `lens` (default: as now) when next opened. */
/** The time now as a document property (W3CDTF, to the second, in UTC). */
const now = (): string => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

async function save(doc: number, request: number, lens?: Format): Promise<void> {
  try {
    const open = current;
    if (open?.doc !== doc || (!open.document && !open.original)) throw new Error('no document');
    // A document changed since it was opened records when.
    if (open.document && open.edited) open.document.properties.modified = now();
    const bytes = await writeWdoc({
      manifest: { version: WDOC_VERSION, lens: lens ?? open.format, origin: open.origin, pagesCurrent: open.pagesCurrent && !open.edited },
      document: open.document ? await open.document.write() : null,
      original: open.original,
      extensions: currentExtensions(open),
    });
    const buffer = bytes.slice().buffer;
    post({ type: 'saved', request, bytes: buffer }, [buffer]);
  } catch (e) {
    post({ type: 'saved', request, bytes: null, error: (e as Error).message });
  }
}

/** The open document exported as a file of a format: only what that format can hold. */
async function exportAs(doc: number, request: number, to: Format): Promise<void> {
  try {
    const open = current;
    if (open?.doc !== doc || (!open.document && !open.original)) throw new Error('no document');
    let bytes: Uint8Array;
    // A PDF whose text wasn't edited exports as the original, pages and all.
    if (to === 'pdf' && open.original && (!open.document || (open.pagesCurrent && !open.edited))) bytes = await annotatedPdf(open.original, currentExtensions(open));
    else bytes = await exportDocument(open.document ?? (await reflow(open.original!, currentExtensions(open))), open.extensions, to, await fontsReady);
    const buffer = bytes.slice().buffer;
    post({ type: 'saved', request, bytes: buffer }, [buffer]);
  } catch (e) {
    post({ type: 'saved', request, bytes: null, error: (e as Error).message });
  }
}

/** Whether a command puts an equation in the document (an inserted one, or a paste that holds one). */
function commandHasMath(wire: WireCommand): boolean {
  if (wire.kind === 'insertContent') return containsMath(wire.content);
  if (wire.kind === 'pasteContent') return containsMath(wire.blocks);
  return false;
}

function containsMath(nodes: readonly { kind: string; [key: string]: any }[]): boolean {
  for (const node of nodes) {
    if (node.kind === 'raw') {
      if (isMathInline(node as Inline)) return true;
    } else {
      for (const key of ['children', 'rows', 'cells']) if (Array.isArray(node[key]) && containsMath(node[key])) return true;
    }
  }
  return false;
}

/** The text a command puts in the document (typing, IME commits, paste, replace). */
function commandText(wire: WireCommand): string {
  switch (wire.kind) {
    case 'insertText':
      return wire.text;
    case 'replaceAll':
      return wire.with;
    case 'setLink':
      return wire.text;
    case 'insertContent': {
      let text = '';
      const walk = (inlines: readonly { kind: string; [key: string]: any }[]) => {
        for (const inline of inlines) {
          if (inline.kind === 'run') for (const c of inline.content) if (c.kind === 'text') text += c.text;
          if (inline.children) walk(inline.children);
        }
      };
      walk(wire.content);
      return text;
    }
    default:
      return '';
  }
}

/** Text without a language of its own is drawn in the catalog for the app's language. */
function setCjkLang(): Promise<void> {
  return fontsReady.then((fonts) => {
    const locale = getLocale();
    fonts.defaultCjkLang = locale.startsWith('zh-Hant') ? 'zh-Hant' : locale.startsWith('zh') ? 'zh-Hans' : locale.startsWith('ko') ? 'ko' : 'ja';
  });
}

/** Settles once the page's language is loaded; documents wait for it so their errors are translated. */
let localeReady: Promise<unknown> = Promise.resolve();

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case 'locale':
      localeReady = loadLocale(message.locale).then(setCjkLang);
      break;
    case 'open':
      void localeReady.then(() => open(message.doc, message.source, message.room));
      break;
    case 'pointer':
      if (current?.doc === message.doc) current.sendPointer(message.pointer);
      break;
    case 'joinRoom':
      if (current?.doc === message.doc) void current.joinLate(message.room);
      break;
    case 'leave':
      current?.leave();
      break;
    case 'marks':
      setFormattingMarks(message.on);
      current?.relayout();
      break;
    case 'reflow':
      setReflowWidth(message.width);
      current?.relayout();
      break;
    case 'media':
      void media(message.doc, message.request, message.part);
      break;
    case 'linkAt':
      post({ type: 'linkAt', request: message.request, url: current?.doc === message.doc ? current.linkAt(message.page, message.x, message.y) : null });
      break;
    case 'command':
      if (current?.doc === message.doc) {
        try {
          current.command(message.command);
        } catch (e) {
          // Keep editing possible: report, and put the selection somewhere valid.
          console.error(e);
          current.editor?.setSelectionIds(current.editor.selectionIds);
          current.sendSelection();
        }
      }
      break;
    case 'insertImage':
      if (current?.doc === message.doc) current.insertImage(new Uint8Array(message.bytes), message.ext, message.width, message.height, message.description);
      break;
    case 'save':
      void save(message.doc, message.request, message.lens);
      break;
    case 'convert':
      void exportAs(message.doc, message.request, message.to);
      break;
    case 'agent':
      void (current?.doc === message.doc ? current.agent(message.name, message.args) : Promise.resolve('Error: no document is open.')).then((result) => post({ type: 'agentResult', request: message.request, result }));
      break;
  }
};

/** #rrggbb as RGB 0–1. */
function parseHex(css: string): [number, number, number] | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(css);
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
