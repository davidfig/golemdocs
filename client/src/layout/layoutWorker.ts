// The layout worker: owns the open document, lays it out, applies edits and streams pages
// (as transferable GPU-ready buffers) and selection geometry to the page. Everything heavy
// happens here, so the page keeps rendering and responding while a document lays out.

import { isMathInline, paragraphLength, sha256Hex, sharedMediaHash, sharedMediaPart, paragraphText, plainText, type DocumentProperties, type Inline, type NumberingReference, type Paragraph, runPropertiesAt, WordDocument, type ParagraphProperties, type RunProperties } from '@golemdocs/docx';
import { Editor, type Command } from '@golemdocs/editor';
import { Replica, ROOM_POLICY, type ClientMessage, type HistoryMark, type RunFormat, type Pointer, type Selection as OpSelection } from '@golemdocs/ops';
import { cloudRoomTransport } from '../collab/cloudRoom.ts';
import { RoomClient, type RoomHost, type RoomStart } from '../collab/roomClient.ts';
import {
  describeFace,
  encodePage,
  FontSet,
  LayoutSession,
  setFormattingMarks,
  setReflowWidth,
  setShowingSource,
  toModel,
  type EncodedPage,
  PageLayout,
  type FaceDescriptor,
} from '@golemdocs/layout';
import { exportDocument, importDocument, type Format } from '../formats/convert.ts';
import type { PdfView } from '../formats/pdfPages.ts';
import { sniffImage } from '../formats/images.ts';
import { networkMedia, type RoomMedia } from '../collab/roomMedia.ts';
import { isLayeredFormat, isPictureFormat, isVectorFormat, readRoomDocument, roomKind, writeRoomDocument } from '../formats/roomDoc.ts';
import type { VectorLayers } from './vectorLayers.ts';
import type { Scene } from '../vector/model.ts';
import { PictureLayers } from './pictureLayers.ts';
import type { Shape } from '../formats/imageDraw.ts';
import { ObjectSync } from './objectSync.ts';
import { isWdoc, readWdoc, WDOC_VERSION, writeWdoc, type Extensions } from '../formats/wdoc.ts';
import type { FormField } from '@golemdocs/pdf';
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
import { DICTIONARY_BASE, FONT_BASE, isPdfCommand, type LegalPage, type DocumentSource, type FromWorker, type LayoutUpdate, type RoomOptions, type SelectionUpdate, type SpellIssue, type TextMark, type ToWorker, type WireBox, type WireCommand, type WordStats, type WireField, type WirePickedObject, type WirePickedText } from './protocol.ts';
import { fontShowcase, plainTextDocument } from './samples.ts';
import { FormatReader } from './selectionFormat.ts';
import { runAgentTool } from './agentTools.ts';
import { runPdfTool } from './agentPdfTools.ts';
import { formatCommand, type FormatAction } from './formatting.ts';
import { linkInSource } from '../formats/wikiLinks.ts';
import { blockShortcut, inlineShortcut, lineShortcut, linkShortcut, tagShortcut, urlShortcut, wikiLinkShortcut, type LineContext } from './autoformat.ts';
import { FORMATS, formatAllows } from '../ui/formats.ts';
import type { Action, DocumentKind, Mark } from '../ui/actions.ts';
import { findIssues, type TextIssue } from '../spelling/check.ts';
import { countText, tableShape } from './wordCount.ts';
import { htmlToPaste } from '../formats/paste.ts';
import { resolveEmbeds, type Embedded } from '../formats/embeds.ts';
import { sourceFromFile } from '../formats/source.ts';
import { APP_WORDS } from '../spelling/appWords.ts';
import { affixEncoding, Dictionary, ENGLISH_SMALL_WORDS } from '../spelling/dictionary.ts';
import { DICTIONARY_FILES, documentLanguage, paragraphLanguage, type SpellLanguage, type Unchecked } from '../spelling/languages.ts';

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

// --- Embeds ----------------------------------------------------------------------------------------
// A Markdown document that embeds a picture or a note (`![[map.png]]`, `![[Note]]`) shows them in place. What they are is stored
// on the page, not here, so each is asked for by title (the `embed` message) and read as the stored document it is.

const embedAnswers = new Map<number, (file: { name: string; bytes: ArrayBuffer } | null) => void>();
let nextEmbed = 1;
/** How long an embedded document may take to come (one in the cloud is downloaded), and a document's embeds all together. */
const EMBED_ASK_MS = 8000;
const EMBEDS_MS = 15000;

function askEmbed(title: string): Promise<{ name: string; bytes: ArrayBuffer } | null> {
  const request = nextEmbed++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(null), EMBED_ASK_MS);
    const finish = (file: { name: string; bytes: ArrayBuffer } | null): void => {
      clearTimeout(timer);
      embedAnswers.delete(request);
      resolve(file);
    };
    embedAnswers.set(request, finish);
    post({ type: 'embed', request, title });
  });
}

/** The stored document a title names: a picture's bytes, or any other document read into the model. Null if there is none (or it can't be read). */
async function embedded(title: string, fonts: FontSet): Promise<Embedded | null> {
  const file = await askEmbed(title);
  if (!file) return null;
  const bytes = new Uint8Array(file.bytes);
  if (sniffImage(bytes)) return { kind: 'image', bytes };
  // A drawing (a stored one, or an SVG file): shown as its picture, with the drawing beside it to be edited there.
  if (isWdoc(bytes) || /\.svgz?$/i.test(file.name)) {
    const drawing = await (await import('../formats/vectorDoc.ts')).storedDrawing(bytes);
    if (drawing) return { kind: 'drawing', ...drawing };
  }
  const source = sourceFromFile(file.name, file.bytes);
  if (!source || source.kind === 'pdf' || source.kind === 'image') return null;
  const { document } = await load(source, fonts);
  return document ? { kind: 'document', document } : null;
}

/** Puts the pictures and notes a Markdown document embeds in place. Whatever isn't found in time stays a link. */
async function showEmbeds(document: WordDocument, fonts: FontSet): Promise<void> {
  try {
    await Promise.race([resolveEmbeds(document, (title) => embedded(title, fonts)), new Promise<void>((resolve) => setTimeout(resolve, EMBEDS_MS))]);
  } catch (e) {
    console.error(e);
  }
}

/**
 * A drawing's SVG is the part beside its picture in the document, and the extension keeps the same text for saving as SVG. Others
 * may have changed the drawing in a room, which writes only the document: the extension is made to follow it.
 */
async function withDrawingText(document: WordDocument | null, lens: Format, extensions: Extensions): Promise<Extensions> {
  if (!document || (lens !== 'svg' && lens !== 'svgz')) return extensions;
  // A drawing edited together is its objects (a room writes only those): the SVG is made from them.
  const vec = extensions.vec;
  if (vec?.meta[0]) {
    const [{ objectsToScene }, { writeSvg }] = await Promise.all([import('../vector/nodes.ts'), import('../vector/svgWrite.ts')]);
    return { ...extensions, svg: { ...extensions.svg, source: writeSvg(objectsToScene({ meta: vec.meta[0], nodes: vec.nodes, defs: vec.defs })) } };
  }
  const text = await (await import('../formats/vectorDoc.ts')).svgOfDocument(document).catch(() => null);
  return text === null ? extensions : { ...extensions, svg: { ...extensions.svg, source: text } };
}

/** The most a picture added to a shared PDF may be, as the text that carries it: one change is one message to the room. */
/** How long a document being opened waits to hear from its room before it opens anyway (the room's answer is taken when it comes). */
const OPEN_JOIN_MS = 3000;

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
    case 'typst':
    case 'docbook':
    case 'jats':
    case 'fb2':
    case 'opml':
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
    case 'svg': {
      const lens: Format = /\.svgz$/i.test(source.name) ? 'svgz' : 'svg';
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
      const document = wdoc.document && !reflowAgain ? await WordDocument.read(wdoc.document) : null;
      const extensions = await withDrawingText(document, wdoc.manifest.lens, wdoc.extensions);
      return {
        name: source.name,
        document,
        extensions,
        original: wdoc.original,
        lens: wdoc.manifest.lens,
        origin: wdoc.manifest.origin,
        pagesCurrent: wdoc.manifest.pagesCurrent,
      };
    }
    case 'docx':
      return flowing(source.name, await WordDocument.read(new Uint8Array(source.bytes)));
    case 'docx-url': {
      const bytes = await (await fetchOk(source.url)).arrayBuffer();
      // What the app stores is a .wdoc (what it is edited as goes with the document); anything else is Word.
      return isWdoc(bytes) ? load({ kind: 'wdoc', name: source.name, bytes }, fonts) : flowing(source.name, await WordDocument.read(new Uint8Array(bytes)));
    }
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

/** Commands that change the editor's settings rather than the document (they work with none open). */
const SETTINGS_COMMANDS = new Set<WireCommand['kind']>(['spellWords', 'spellIgnored', 'spellCheck', 'autoFormat', 'livePreview']);

/** The settings commands with no document open (see `close`): they change what the worker does for the next one, and for plain text files. */
function applySettings(wire: WireCommand): void {
  if (wire.kind === 'spellWords') void acceptSpelling(wire.words ?? []);
  else if (wire.kind === 'spellIgnored') ignoreSpelling(wire.words, wire.rules);
  else if (wire.kind === 'spellCheck') {
    live.spelling = wire.spelling;
    live.grammar = wire.grammar;
    void acceptSpelling(wire.words ?? []);
  } else if (wire.kind === 'autoFormat') live.autoFormat = wire.on;
  else if (wire.kind === 'livePreview') live.livePreview = wire.on;
}
/** Commands that only look: allowed on a document shown as PDF, which can't be edited. */
const VIEW_COMMANDS = new Set<WireCommand['kind']>(['pointer', 'move', 'selectAll', 'find', 'spellNext', 'spellWords', 'spellIgnored', 'spellCheck', 'autoFormat', 'spellAt', 'countWords', 'getProperties']);

/** Faces the page already has (it keeps them across documents). */
const sentFaces = new Set<string>();

interface Person {
  name: string;
  picture: string | null;
  color: number;
  selection: OpSelection | null;
  pointer: Pointer | null;
}

/** A room going from a document to the one that replaces it (the same picture or drawing, changed: see OpenDocument.handOverRoom). */
interface CarriedRoom {
  net: RoomClient;
  target: { entry: OpenDocument };
  clientId: string;
  netDoc: string | null;
}

/**
 * What a room is given as its document: whichever document has it now. A changed picture or drawing is opened again in place of the
 * old one, and its room goes with it rather than being left and joined again. Handing the document over waits until it has loaded.
 */
function forwardingHost(target: { entry: OpenDocument }): RoomHost {
  const host = (): RoomHost => target.entry.hostForRoom();
  // At once when it can be: what a document does to write itself out (a Markdown paragraph shown as source is read back first)
  // takes its turn with the commands, and must go ahead of the freeze the hand-over then puts on them.
  const serialize = (): Promise<Uint8Array> => (target.entry.isSetUp ? host().serialize() : target.entry.setUp.then(() => host().serialize()));
  // Every other call goes to the document that has the room now, whatever the call is (so one added to RoomHost can't be missed here).
  return new Proxy({} as RoomHost, {
    get: (_, key) => {
      if (key === 'serialize') return serialize;
      if (typeof key !== 'string' || key === 'then') return undefined; // not a promise, whatever awaits it
      return (...args: unknown[]) => (host()[key as keyof RoomHost] as ((...a: unknown[]) => unknown) | undefined)?.(...args);
    },
  });
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
  /** A picture's layers (the shapes drawn over it), their history, and their changes shared with a room (see pictureLayers.ts). */
  layers: PictureLayers | null = null;
  layerSync: ObjectSync | null = null;
  private pictureSize = { width: 0, height: 0 };
  /** The PDF's pages laid out so far, in order. */
  private pdfPages: PageLayout[] = [];
  /** Ids for PDF pages laid out again (the first layout of page i has id i). */
  private nextPdfPageId = 0;
  document: WordDocument | null = null;
  replica: Replica | null = null;
  session: LayoutSession | null = null;
  editor: Editor | null = null;
  formats: FormatReader | null = null;
  /** The multiplayer server's room, for a cloud document. */
  net: RoomClient | null = null;
  private clientId = '';
  private readonly people = new Map<string, Person>();
  /** A network room the page asked to join while the document was still being set up. */
  private lateRoom: RoomOptions | null = null;
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
  /** The languages whose dictionaries the squiggles are waiting for. */
  private loadingMarks = new Set<SpellLanguage>();
  /** The last Word Count's answer, sent with the next selection (null: none to give). */
  private stats: SelectionUpdate['stats'] = undefined;
  private footerStats: SelectionUpdate['footerStats'] = undefined;
  /** The document's properties, asked for by File ▸ Properties, sent with the next selection. */
  private props: DocumentProperties | undefined = undefined;
  /** Formatting the Format Painter has picked up: the paragraph's only when a whole paragraph was copied. */
  private painter: { run: RunProperties; paragraph: ParagraphProperties | null } | null = null;

  /**
   * Settles once the document can be worked on, or never will be (it failed to open, or another was
   * opened). Messages for it can arrive while it is still loading: what needs the document waits for this.
   */
  readonly setUp: Promise<void>;
  /** `setUp` has settled. */
  isSetUp = false;
  private settleSetUp!: () => void;

  constructor(readonly doc: number) {
    this.setUp = new Promise((resolve) => {
      this.settleSetUp = () => {
        this.isSetUp = true;
        resolve();
      };
    });
    this.controller.signal.addEventListener('abort', () => this.setUpDone());
  }

  /** The document can be worked on now, or never will be: what was waiting for it goes ahead. */
  setUpDone(): void {
    this.settleSetUp();
  }

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

  /** Bumped by each pumpPdf, so an earlier one still running (a page operation laid everything out again) stops. */
  private pdfPass = 0;

  /** Lays out a PDF's pages one after another, sending them as they come (first pages appear at once). */
  async pumpPdf(): Promise<number> {
    const { view } = this.pdf!;
    const pass = ++this.pdfPass;
    const start = performance.now();
    let sliceStart = start;
    for (let i = 0; i < view.pageCount && !this.closed && pass === this.pdfPass; i++) {
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
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
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
      footerStats: this.footerStats,
      docProperties: this.props,
    };
    this.search = null;
    this.spell = null;
    this.stats = undefined;
    this.footerStats = undefined;
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
      footerStats: this.footerStats,
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
    // Someone who may only look (a viewer, cut off from the room, or watching while someone else holds it) can select and copy, nothing more.
    if (this.readOnly && wire.kind !== 'pointer' && wire.kind !== 'selectAll') return this.refusedWatching();
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
        case 'move':
          if (!Number.isInteger(wire.to) || wire.to < 0 || wire.to >= doc.pageCount || wire.to === index) return;
          doc.movePage(index, wire.to);
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

  /** The cloud document whose room this is in, for its pictures. */
  private netDoc: string | null = null;

  /** Joins a room asked for while the document was being set up. */
  ready(): void {
    this.setUpDone();
    this.postRoomState();
    const late = this.lateRoom;
    this.lateRoom = null;
    if (late) void this.joinLate(late);
  }

  private sendPresence(): void {
    if (!this.net || !this.editor) return;
    const selection = this.editor.selectionIds;
    const key = JSON.stringify(selection);
    if (key === this.lastPresence) return;
    this.lastPresence = key;
    this.net.presence(selection);
  }

  leave(): void {
    this.net?.leave();
  }

  /**
   * Joins the room for a document that was already open (a new one once uploaded, or a saved one
   * shown before it was known who is signed in). When someone else is editing, the room's document
   * would replace this one: if nothing was typed here the page reopens it from the room; otherwise
   * it carries on unshared and is merged as a separate copy later.
   */
  async joinLate(room: RoomOptions): Promise<void> {
    if (this.net) return;
    // Still being set up (the page heard who is signed in first): joined once it is, as the page
    // asks only once.
    if (this.format === 'pdf' ? !this.annotator : isPictureFormat(this.format) ? !this.layerSync : !this.replica || !this.editor) {
      this.lateRoom = room;
      return;
    }
    const client = this.replica?.clientId ?? crypto.randomUUID().slice(0, 8);
    const start = await this.joinNetwork(room, client);
    if (start) this.startLate(start);
  }

  /** The room answered once the document was already open (see joinLate and joinWithin). */
  private startLate(start: RoomStart): void {
    if (this.closed || !this.net) return;
    if (start.kind === 'own') return this.net.ready(start);
    this.net.leave();
    this.net = null;
    this.roomTarget = null;
    // Nothing typed here yet: the page reopens the document from the room's copy instead.
    if (!this.edited) post({ type: 'roomReplace', doc: this.doc });
  }

  /**
   * Joins as a document opens, but waits only `ms` for the room to answer: a room that is slow to answer doesn't keep the document
   * from opening. It then opens as it is, and the room's answer is taken when it comes (as for a late join). A room that has answered
   * and is handing the document over from someone else already in it is waited for: that is the document to open.
   */
  async joinWithin(room: RoomOptions, clientId: string, ms: number): Promise<RoomStart | null> {
    const joining = this.joinNetwork(room, clientId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), ms)));
    const first = await Promise.race([joining, late]);
    clearTimeout(timer);
    if (first !== 'late') return first;
    if (this.joining?.answered) return joining;
    void joining.then(async (start) => {
      await this.setUp;
      if (start) this.startLate(start);
    });
    return null;
  }

  /** The room being joined (until it says where the document comes from). */
  private joining: RoomClient | null = null;

  /** The room of the document this one replaces (the same picture or drawing, changed), handed over rather than left and joined again. */
  private roomTarget: { entry: OpenDocument } | null = null;

  /** Gives up this document's room to the one that replaces it (see takeRoom). Only alone, and not while handing the document to the room. */
  handOverRoom(): CarriedRoom | null {
    const net = this.net;
    const target = this.roomTarget;
    if (!net || !target || net.state.mode !== 'solo' || net.handingOver) return null;
    this.net = null;
    this.roomTarget = null;
    return { net, target, clientId: this.clientId, netDoc: this.netDoc };
  }

  /** Takes over the room of the document this one replaces: from now on the room speaks to this one. */
  takeRoom(carried: CarriedRoom): void {
    this.net = carried.net;
    this.roomTarget = carried.target;
    carried.target.entry = this;
    this.clientId = carried.clientId;
    this.netDoc = carried.netDoc;
  }

  /** What the room needs from this document, for what it is. */
  hostForRoom(): RoomHost {
    const kind = roomKind(this.format);
    return ROOM_POLICY[kind] === 'watch' ? this.watchRoomHost() : kind === 'nodes' ? this.drawingRoomHost() : this.roomHost();
  }

  // --- The multiplayer server ---------------------------------------------------------

  /** Others are editing this document with this person now. Alone in a cloud document (the room only tells who else is here) a picture's bytes are in the file, and go with it to whoever joins later; once shared they are not in the changes the room passes on. */
  private get shared(): boolean {
    return this.net !== null && this.net.state.mode !== 'solo';
  }

  /** A drawing's SVG is the part beside its picture in the document, and the extension keeps the same text for saving as SVG: after changes from others, the extension is made to match. */
  drawingChanged(): void {
    if ((this.format !== 'svg' && this.format !== 'svgz') || !this.document) return;
    const document = this.document;
    void import('../formats/vectorDoc.ts').then(async ({ svgOfDocument }) => {
      const text = await svgOfDocument(document).catch(() => null);
      if (text !== null && this.document === document) this.extensions = { ...this.extensions, svg: { ...this.extensions.svg, source: text } };
    });
  }

  /** Viewers, anyone whose connection to the room is gone, and anyone watching while someone else holds the document can look but not edit. */
  get readOnly(): boolean {
    return this.net !== null && (!this.net.canEdit || this.net.watching || this.net.catchingUp);
  }

  private postPointers(): void {
    const pointers = [];
    for (const person of this.people.values()) if (person.pointer) pointers.push({ ...person.pointer, color: person.color, name: person.name, picture: person.picture });
    post({ type: 'pointers', doc: this.doc, pointers });
  }

  /** This user's mouse, for the other people in the room. */
  sendPointer(pointer: Pointer | null): void {
    this.net?.pointer(pointer);
  }

  private postRoomState(): void {
    const net = this.net;
    if (!net) return;
    const { mode, role, people, holder, watching, catchingUp } = net.state;
    post({ type: 'roomState', doc: this.doc, mode, role, people: people.map(({ client, name, picture, color }) => ({ name, picture, color, me: client === this.clientId })), unconfirmed: this.replica?.sync?.unconfirmed ?? this.layerSync?.unconfirmed ?? 0, holder: holder && { name: holder.name, mine: holder.mine }, watching, catchingUp });
  }

  /**
   * Joins the multiplayer server's room for this cloud document. Returns where the document comes
   * from, or null when there is no room to join (signed out, offline, no access, local-only server):
   * the document is then edited as a plain one and saved as usual.
   */
  async joinNetwork(room: RoomOptions, clientId: string): Promise<RoomStart | null> {
    this.clientId = clientId;
    const docId = room.docId;
    this.netDoc = docId;
    const target = { entry: this as OpenDocument };
    const net = new RoomClient({
      client: clientId,
      name: room.user,
      color: room.color,
      kind: roomKind(this.format),
      host: forwardingHost(target),
      ...cloudRoomTransport(docId),
      upload: async (bytes) => {
        const response = await fetch(`/api/documents/${docId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
          body: bytes as Uint8Array<ArrayBuffer>,
        });
        if (!response.ok) throw new Error(`upload failed (${response.status})`);
      },
    });
    this.joining = net;
    try {
      const start = await net.join();
      if (this.closed) {
        // Another document was opened while joining: nobody is left to use this room.
        net.leave();
        return null;
      }
      this.net = net;
      this.roomTarget = target;
      return start;
    } catch (error) {
      console.warn('no multiplayer room:', (error as Error).message);
      net.leave();
      // The page asks again later (once the document is next saved to the account).
      if (!this.closed) post({ type: 'roomGone', doc: this.doc });
      return null;
    }
  }

  /** The room can't be reached and we were alone in it: the document is edited and saved as if it had no room, until the page joins again. */
  lostRoom(): void {
    this.net?.leave();
    this.net = null;
    this.roomTarget = null;
    this.people.clear();
    this.postPointers();
    if (!this.closed) post({ type: 'roomGone', doc: this.doc });
  }

  /** The whole document as a .wdoc, as it is now (what is saved, and what a PDF's room starts from: the file with the lists of what is on its pages). */
  async wdocBytes(): Promise<Uint8Array> {
    return writeWdoc({
      manifest: { version: WDOC_VERSION, lens: this.format, origin: this.origin, pagesCurrent: this.pagesCurrent && !this.edited },
      document: this.document ? await this.document.write() : null,
      original: this.original,
      extensions: currentExtensions(this),
    });
  }

  /** A drawing being edited together: its nodes as objects (changed through `layerSync`), and how to write it as SVG. */
  vectorLayers: VectorLayers | null = null;
  private svgText: ((scene: Scene) => string) | null = null;

  private vectorSetup: Promise<void> | null = null;

  /**
   * A drawing is edited together from now on: its nodes become objects, from what the room has, else from the drawing, and the page
   * is given them (named as the room names them). Alone, a drawing is never made objects of: only once someone else is here (it is
   * handed to the room, or opened from the room's copy).
   */
  ensureVector(): Promise<void> {
    this.vectorSetup ??= (async () => {
      const [{ VectorLayers }, { readSvg }, { writeSvg }] = await Promise.all([import('./vectorLayers.ts'), import('../vector/svgRead.ts'), import('../vector/svgWrite.ts')]);
      this.svgText = writeSvg;
      const vec = this.extensions.vec;
      this.vectorLayers = vec ? new VectorLayers(vec) : new VectorLayers(readSvg(this.extensions.svg?.source ?? ''));
      this.layerSync = new ObjectSync(this.vectorLayers, this.clientId);
      this.keepVector();
      this.postVector(true);
    })();
    return this.vectorSetup;
  }

  /** The drawing's objects are saved with the document, and the SVG that exports and conversions are made from follows them. */
  private keepVector(): void {
    const layers = this.vectorLayers;
    if (!layers || !this.svgText) return;
    this.extensions = { ...this.extensions, vec: layers.extension, svg: { ...this.extensions.svg, source: this.svgText(layers.scene) } };
  }

  /** Tells the page the drawing as it stands (null: it has not changed) and whether the person's changes can be stepped back over. */
  postVector(withScene: boolean): void {
    if (!this.vectorLayers) return;
    post({ type: 'vectorScene', doc: this.doc, scene: withScene ? this.vectorLayers.scene : null, canUndo: this.layerSync?.canUndo ?? false, canRedo: this.layerSync?.canRedo ?? false });
  }

  /** The person changed the drawing from `base` to `scene`: what others changed meanwhile is kept, and the page is given the result. */
  setVectorScene(scene: Scene, base?: Scene): void {
    if (!this.vectorLayers || !this.layerSync || this.readOnly) return this.postVector(true);
    let merged = false;
    const layers = this.vectorLayers;
    const change = base && layers.change(base, scene);
    if (change) merged = this.layerSync.localFrom(change.from, change.to, () => layers.set(scene));
    else {
      this.vectorLayers.set(scene);
      this.layerSync.local();
    }
    this.edited = true;
    this.keepVector();
    this.postVector(merged);
  }

  /** Undo or redo of the person's own changes to the drawing. */
  stepVector(action: 'undo' | 'redo'): void {
    if (!this.layerSync || this.readOnly) return;
    if (action === 'undo') this.layerSync.undo();
    else this.layerSync.redo();
    this.edited = true;
    this.keepVector();
    this.postVector(true);
  }

  /** A picture opened: its layers are the shapes kept with it, and the page is told them. */
  async setupLayers(client: string): Promise<void> {
    this.layers = new PictureLayers(this.extensions.img?.shapes);
    this.layerSync = new ObjectSync(this.layers, client);
    this.keepLayers();
    const picture = this.document ? await (await import('../formats/imageDoc.ts')).firstPicture(this.document).catch(() => null) : null;
    if (picture) this.pictureSize = { width: picture.image.width, height: picture.image.height };
  }

  /** The layers are saved with the picture. */
  private keepLayers(): void {
    const shapes = [...(this.layers?.shapes ?? [])];
    const { img: _old, ...rest } = this.extensions;
    this.extensions = shapes.length ? { ...rest, img: { shapes } } : rest;
  }

  /** Tells the page the picture's shapes and whether they can be stepped back over. */
  postShapes(): void {
    const sync = this.layerSync;
    post({ type: 'shapes', doc: this.doc, shapes: [...(this.layers?.shapes ?? [])], ...this.pictureSize, canUndo: sync?.canUndo ?? false, canRedo: sync?.canRedo ?? false });
  }

  /** The person drew, erased or moved something, changing the shapes from `base` to these: what others changed meanwhile is kept. */
  setShapes(shapes: Shape[], base?: Shape[]): void {
    if (!this.layers || !this.layerSync || this.readOnly) return this.postShapes();
    const layers = this.layers;
    // Shapes without ids (none from this page, but a list given whole) can't be told apart from new ones: those replace the list.
    if (base?.every((s) => s.id)) this.layerSync.localFrom(PictureLayers.objectsOf(base), PictureLayers.objectsOf(shapes), () => layers.set(shapes));
    else {
      this.layers.set(shapes);
      this.layerSync.local();
    }
    this.edited = true;
    this.keepLayers();
    this.postShapes();
  }

  /** Undo or redo of the person's own changes to the shapes. */
  stepShapes(action: 'undo' | 'redo'): void {
    if (!this.layerSync || this.readOnly) return;
    if (action === 'undo') this.layerSync.undo();
    else this.layerSync.redo();
    this.edited = true;
    this.keepLayers();
    this.postShapes();
  }

  /** Changes to a drawing's nodes from the room. */
  private receiveLayers(message: Parameters<ObjectSync['receive']>[0]): void {
    const sync = this.layerSync;
    if (!sync) return;
    const got = sync.receive(message);
    if (got.length === 0) return;
    this.edited = true;
    post({ type: 'remoteEdit', doc: this.doc });
    this.keepVector();
    this.postVector(true);
  }

  /** What every room host does the same: commands wait for a hand-over, and the other people's carets and pointers are kept and shown. `selections`: the carets are in text, so they are kept and mapped too. */
  private presenceHost(selections: boolean): Pick<RoomHost, 'freeze' | 'people' | 'pointers' | 'lost'> {
    return {
      lost: () => this.lostRoom(),
      // Commands made while the document is being handed over wait for the handover.
      freeze: (until) => this.later(() => until.then(() => {}, () => {})),
      people: (list) => {
        this.people.clear();
        for (const p of list) if (p.client !== this.clientId) this.people.set(p.client, { name: p.name, picture: p.picture, color: p.color, selection: selections ? p.selection : null, pointer: p.pointer });
        this.postPointers();
        if (selections) this.sendSelection();
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

  /**
   * What the room of a document of lists of objects (a picture's shapes, a drawing's nodes, a PDF's markup) needs from it: its changes
   * go out through an `ObjectSync`, and others' come in through it. `sync` finds the ObjectSync now (a PDF's is made when it connects).
   */
  private objectsRoomHost(o: { sync(): ObjectSync | null; connect(send: (message: ClientMessage) => void, version: number): void; disconnect(): void; receive(message: Parameters<ObjectSync['receive']>[0]): void }): RoomHost {
    return {
      ...this.presenceHost(false),
      serialize: () => this.wdocBytes(),
      connect: o.connect,
      disconnect: o.disconnect,
      receive: o.receive,
      sync: () => {
        const sync = o.sync();
        return sync?.connected ? { version: sync.version, unconfirmed: sync.unconfirmed } : null;
      },
      resubmit: () => o.sync()?.resubmit(),
      changed: () => this.postRoomState(),
    };
  }

  /**
   * A drawing's room: its changes to the nodes go out through `layerSync`. A drawing has none until it is edited together: it is made
   * when the drawing is handed to the room, or (for someone who can't edit, so hands nothing over) when the room connects, and what
   * the room sends meanwhile waits for it.
   */
  private drawingRoomHost(): RoomHost {
    const host = this.objectsRoomHost({
      sync: () => this.layerSync,
      connect: (send, version) => void this.ensureVector().then(() => this.layerSync?.connect(send, version)),
      disconnect: () => this.layerSync?.disconnect(),
      receive: (message) => void this.ensureVector().then(() => this.receiveLayers(message)),
    });
    host.serialize = () => this.ensureVector().then(() => this.wdocBytes());
    return host;
  }

  /**
   * A watched room's (a PDF's or a picture's: see ROOM_POLICY): nothing is edited through it. Holding the document, it is saved as if
   * alone, and the page saves now when someone starts watching or takes over; watching, the page opens it again when it is saved.
   */
  private watchRoomHost(): RoomHost {
    return {
      ...this.presenceHost(false),
      serialize: () => this.wdocBytes(),
      connect: () => {},
      disconnect: () => {},
      receive: () => {},
      sync: () => null,
      resubmit: () => {},
      changed: () => this.postRoomState(),
      saved: (updatedAt) => post({ type: 'roomSaved', doc: this.doc, updatedAt }),
      release: () => post({ type: 'roomRelease', doc: this.doc }),
      flush: () => post({ type: 'roomFlush', doc: this.doc }),
    };
  }

  /** Asks to hold the document others are editing one at a time (a watched room). */
  takeOver(): void {
    this.net?.takeOver();
  }

  /** The page saved what there was, as the room asked (someone takes over): someone else may hold the document now. */
  released(): void {
    this.net?.released();
  }

  /** An edit was asked for while someone else holds the document: the person is told who, and how to change it. */
  private refusedWatching(): void {
    const holder = this.net?.watching ? this.net.state.holder : null;
    if (holder) this.notice(holder.mine ? t('room.watchingMineNoEdit') : t('room.watchingNoEdit', { name: holder.name }));
  }

  /** Why the document can't be changed, for the assistant. */
  whyReadOnly(): string {
    const holder = this.net?.state.holder;
    if (this.net?.watching && holder) return holder.mine ? 'this document is being edited on another of the person’s devices; take it over (take_over_editing) to change it here.' : `${holder.name} is editing this document now; take it over (take_over_editing) to change it.`;
    return 'this document cannot be changed (it can only be viewed, or its connection was lost).';
  }

  /** The document as the room holds it: what it is edited as and what only that format keeps go with it. */
  private async roomDocument(): Promise<Uint8Array> {
    // A paragraph being edited as Markdown source is read back first, so the room starts from the formatted text.
    const resume = await this.flushRaw();
    try {
      await this.document!.fetchMissingMedia();
      return await writeRoomDocument({ docx: await this.document!.write(), lens: this.format, origin: this.origin, extensions: currentExtensions(this) });
    } finally {
      resume();
    }
  }

  /** What the room needs from this document. */
  private roomHost(): RoomHost {
    return {
      ...this.presenceHost(true),
      serialize: () => this.roomDocument(),
      connect: (send, version) => this.replica!.connect(send, version),
      disconnect: () => this.replica?.disconnect(),
      receive: (message) => {
        const { change } = this.editor!.receive(message);
        if (change) {
          this.drawingChanged();
          // Other people's carets move with the text too.
          for (const person of this.people.values()) if (person.selection) person.selection = Replica.mapSelection(person.selection, change.mapping);
          this.edited = true;
          post({ type: 'remoteEdit', doc: this.doc });
          void this.pump();
        }
        this.postRoomState();
      },
      sync: () => this.replica?.sync ?? null,
      resubmit: () => this.replica?.resubmit(),
      changed: () => {
        this.postRoomState();
        this.sendSelection();
      },
    };
  }

  /** A picture at the caret, no wider than the page's text. Not in a room: the others would have no bytes for it. */
  insertImage(bytes: Uint8Array, ext: string, width: number, height: number, description?: string): void {
    // Asked for while the document is still loading: once it has, in turn with the commands.
    if (!this.isSetUp) return this.later(() => this.setUp.then(() => this.insertImage(bytes, ext, width, height, description)));
    const document = this.document;
    if (!document || this.readOnly || this.pdf) return;
    const { pageSize, margins } = document.section;
    const most = ((pageSize?.w ?? 12240) - (margins?.left ?? 1440) - (margins?.right ?? 1440)) * 635;
    if (most > 0 && width > most) {
      height = Math.round((height * most) / width);
      width = most;
    }
    const place = (image: string) => this.apply({ kind: 'insertContent', content: [{ kind: 'run', properties: {}, content: [{ kind: 'drawing', inline: true, width, height, image, ...(description && { description }) }], attrs: {} }] });
    // Alone, at once. With others, once the picture is in the room for them to fetch.
    if (!this.shared) return place(document.addImage(bytes, ext));
    this.mediaChain = this.mediaChain.then(() => this.addMedia(bytes, ext)).then(
      (image) => this.later(() => place(image)),
      (error) => this.mediaFailed(error),
    );
  }

  /** Pictures put in the room one after another, so what is added last is applied last. */
  private mediaChain: Promise<unknown> = Promise.resolve();

  /**
   * Puts a picture's bytes in the document as a part, and says its name. Alone, the part is named as the package likes. With others
   * editing it, the part is named for the hash of its bytes (so no two people give different pictures one name), and the bytes are put
   * in the room first, since the change that names it is all the others are sent.
   */
  private async addMedia(bytes: Uint8Array, ext: string): Promise<string> {
    const document = this.document!;
    const store = this.shared ? this.mediaStore() : null;
    if (!store) return document.addImage(bytes, ext);
    const hash = await sha256Hex(bytes);
    const part = sharedMediaPart(hash, ext);
    if (!document.hasPart(part)) document.setMedia(part, bytes);
    await store.put(hash, bytes);
    return part;
  }

  /** Tells the person something that isn't a failure. */
  private notice(message: string): void {
    post({ type: 'notice', doc: this.doc, message });
  }

  private mediaFailed(error: unknown): void {
    this.notice(t('picture.shareFailed', { message: (error as Error).message }));
  }

  /** A picture another person added to the document being edited together, from the room; null for any other part, or when there is no room. */
  async fetchRoomMedia(part: string): Promise<Uint8Array | null> {
    const hash = sharedMediaHash(part);
    const store = hash ? this.mediaStore() : null;
    return hash && store ? store.get(hash).catch(() => null) : null;
  }

  /** Where the pictures of the room this document is in are kept. */
  private mediaStore(): RoomMedia | null {
    return this.netDoc ? networkMedia(this.netDoc) : null;
  }

  /** A vector drawing: at the caret, or in place of the embedded one whose SVG is package part `replace`, in one undoable step. */
  putDrawing(svg: string, png: Uint8Array, width: number, height: number, description?: string, replace?: string): void {
    if (!this.isSetUp) return this.later(() => this.setUp.then(() => this.putDrawing(svg, png, width, height, description, replace)));
    const document = this.document;
    if (!document || this.readOnly || this.pdf) return;
    if (!replace) {
      const { pageSize, margins } = document.section;
      const most = ((pageSize?.w ?? 12240) - (margins?.left ?? 1440) - (margins?.right ?? 1440)) * 635;
      if (most > 0 && width > most) {
        height = Math.round((height * most) / width);
        width = most;
      }
    }
    const place = (image: string, svgPart: string) => {
      const drawing = { kind: 'drawing' as const, inline: true, width, height, image, svg: svgPart, ...(description && { description }) };
      if (replace) this.apply({ kind: 'replaceDrawing', svg: replace, drawing });
      else this.apply({ kind: 'insertContent', content: [{ kind: 'run', properties: {}, content: [drawing], attrs: {} }] });
    };
    // Alone, at once. With others, once the parts are in the room for them to fetch.
    if (!this.shared) return place(document.addImage(png, 'png'), document.addImage(new TextEncoder().encode(svg), 'svg'));
    this.mediaChain = this.mediaChain.then(() => Promise.all([this.addMedia(png, 'png'), this.addMedia(new TextEncoder().encode(svg), 'svg')])).then(
      ([image, svgPart]) => this.later(() => place(image, svgPart)),
      (error) => this.mediaFailed(error),
    );
  }

  /** Commands waiting for fonts a formatting command needs; later ones queue behind it. */
  waiting: Promise<void> | null = null;

  command(wire: WireCommand): void {
    if (this.waiting) return this.later(() => this.runCommand(wire));
    const done = this.runCommand(wire);
    if (done) this.later(() => done);
  }

  /** One of the assistant's tools, run on this document (see agentTools.ts). Settles with its answer once its edits have taken effect. */
  async agent(name: string, args: string, show: (images: string[]) => void = () => {}): Promise<string> {
    // Asked for while the document is still loading: once it has, and the commands sent before have run.
    if (!this.isSetUp) await this.turn();
    if (this.annotator && !this.closed) return this.agentPdf(this.annotator, name, args);
    const editor = this.editor;
    if (!editor || this.closed || this.annotator) return 'Error: this document has no text to work with.';
    // The assistant works on the formatted text: a source being edited is put away until it is done.
    this.rawPaused++;
    try {
      await new Promise<void>((resolve) => this.later(() => this.syncRaw().then(() => this.finishRaw()).finally(resolve)));
      return await runAgentTool(
        {
          editor,
          readOnly: this.readOnly || this.format === 'pdf',
          run: async (wire) => {
            // Another document was opened meanwhile: this one's editor is no longer the page's.
            if (this.closed) throw new Error('the document was closed');
            this.command(wire);
            while (this.waiting) await this.waiting;
          },
          format: () => this.formats!.read(...editor.ordered(), editor.paragraphs(), editor.pending),
          show,
        },
        name,
        args,
      );
    } finally {
      this.rawPaused--;
      this.later(() => this.syncRaw().then(() => this.finishRaw()));
    }
  }

  /** One of the assistant's tools on a PDF shown as its own pages (see agentPdfTools.ts). */
  private agentPdf(annotator: PdfAnnotator, name: string, args: string): Promise<string> {
    const ids = () => this.pdfPages;
    const pageCount = () => this.pdf?.view.pageCount ?? 0;
    const readOnly = (): string | null => (this.readOnly ? this.whyReadOnly() : null);
    return runPdfTool(
      {
        annotator,
        get pageCount() {
          return pageCount();
        },
        characters: (index) => this.pdf?.view.characters(index) ?? [],
        pageId: (index) => ids()[index]?.id,
        pageSize: (index) => ids()[index] && { width: ids()[index]!.width, height: ids()[index]!.height },
        fields: () => annotator.fields.map((f) => this.wireField(f)).filter((f) => f !== null),
        run: async (wire) => {
          if (this.closed) throw new Error('the document was closed');
          this.command(wire);
          while (this.waiting) await this.waiting;
        },
        get readOnly() {
          return readOnly();
        },
        pageOp: (index, op) => this.pdfPageOp(annotator, { kind: 'pdfPageOp', page: ids()[index]!.id, op }),
        pick: (index, x, y) => this.pickText(annotator, index, x, y),
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

  /** Enter on an empty list item ends the list: the paragraph loses its bullet or number instead of splitting. */
  private endEmptyListItem(editor: Editor): boolean {
    if (!editor.collapsed || !this.formats) return false;
    const [at] = editor.ordered();
    if (paragraphLength(at.paragraph) > 0) return false;
    const { list } = this.formats.read(...editor.ordered(), editor.paragraphs(), editor.pending);
    if (!list) return false;
    this.applyFormat({ kind: 'toggleList', list });
    return true;
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
  private countWords(whole: boolean, footer: boolean): void {
    const { editor, session } = this;
    let stats: WordStats | null = null;
    if (editor && session && !this.closed && !this.annotator) {
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
      stats = { ...countText(texts), pages: selection ? pagesUsed.size : session.displayPages.length, lines, selection };
      if (footer && (this.format === 'csv' || this.format === 'tsv') && this.document) stats.table = tableShape(this.document.body);
    }
    // The status bar asks on its own: its answer must not land in the Word Count dialog.
    if (footer) this.footerStats = stats;
    else this.stats = stats;
    this.sendSelection();
  }

  /** When the last edit was made here (performance.now()): squiggles hold off for the word just finished until the typing pauses. */
  private typedAt = -Infinity;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;

  /** The squiggles for the pages shown: red under misspelled words, green under grammar mistakes. */
  private spellMarks(editor: Editor): Float64Array {
    if (!live.spelling && !live.grammar) return new Float64Array(0);
    const [start, end] = editor.ordered();
    const typing = start.paragraph === end.paragraph && start.offset === end.offset ? start : null;
    // Typing along: the word just finished (and the space or mark after it) is not underlined until a pause, so a squiggle doesn't flash under every word as it is typed.
    const sinceTyped = performance.now() - this.typedAt;
    const settling = typing !== null && sinceTyped < SPELL_SETTLE_MS;
    clearTimeout(this.settleTimer);
    if (settling) this.settleTimer = setTimeout(() => this.sendSelection(), SPELL_SETTLE_MS - sinceTyped + 20);
    const documentLang = documentLanguageOf(editor);
    const marks = editor.marks((paragraph) =>
      issuesOf(paragraph, documentLang, (language) => {
        // A dictionary is fetched the first time a paragraph in its language is checked.
        if (this.loadingMarks.has(language)) return;
        this.loadingMarks.add(language);
        loadDictionary(language)
          .then(() => this.sendSelection())
          .catch(() => undefined)
          .finally(() => this.loadingMarks.delete(language));
      })
        // The word being typed isn't marked until the caret leaves it.
        .filter((i) => !(typing && typing.paragraph === paragraph && i.start < typing.offset && (typing.offset <= i.end || (settling && typing.offset - i.end <= SPELL_FINISHED_REACH))))
        .map((i) => ({ start: i.start, end: i.end, kind: i.kind === 'spelling' ? 0 : 1 })),
    );
    const out = new Float64Array(marks.length * 6);
    marks.forEach((m, i) => out.set([m.page.id, m.x, m.y, m.width, m.height, m.kind], i * 6));
    return out;
  }

  /** The address of the link under a point on a page (null when there is none, or the document isn't text). */
  linkAt(pageId: number, x: number, y: number): { url: string | null; checkbox: boolean } {
    const page = this.session?.displayPages.find((p) => p.id === pageId);
    if (!this.editor || !page || this.closed || this.annotator) return { url: null, checkbox: false };
    const profile = FORMATS[this.format as DocumentKind];
    const checkbox = !this.readOnly && !!profile?.editable && profile.lists && !!this.editor.checkboxUnder(page, x, y);
    let url = this.editor.linkUnder(page, x, y);
    // The paragraph showing its Markdown holds the links it shows as characters.
    if (url === null && this.raw) {
      const under = this.editor.charUnder(page, x, y);
      if (under && this.editor.paragraphId(under.paragraph) === this.raw.id) url = linkInSource(paragraphText(under.paragraph), under.offset);
    }
    return { url, checkbox };
  }

  /** Selects the mistake under the point (unless `select` is false) and reports it for the menu (nothing, if there is none). */
  private async spellAt(pageId: number, x: number, y: number, select: boolean): Promise<void> {
    const editor = this.editor;
    const session = this.session;
    if (!editor || !session || this.closed || this.annotator) return;
    const page = session.displayPages.find((p) => p.id === pageId);
    const hit = page && editor.hitTest(page, x, y);
    const documentLang = documentLanguageOf(editor);
    const language = hit && paragraphLanguageOf(hit.paragraph, documentLang);
    const dictionary = language && language !== 'none' ? await loadDictionary(language) : null;
    this.spell = { issue: null, menu: true };
    if (hit && dictionary) {
      const issue = issuesOf(hit.paragraph, documentLang, () => undefined).find((i) => i.start <= hit.offset && hit.offset <= i.end);
      if (issue) {
        this.spell = { issue: describeIssue(paragraphText(hit.paragraph), issue, dictionary), menu: true };
        if (select) editor.apply({ kind: 'select', paragraph: editor.paragraphs().indexOf(hit.paragraph), from: issue.start, to: issue.end });
      }
    }
    this.reveal = false;
    this.sendSelection();
  }

  /** Selects the next spelling or grammar mistake at or after the place `from` says, and reports it. */
  private async spellNext(from: 'documentStart' | 'selectionStart' | 'selectionEnd', grammar: boolean): Promise<void> {
    const editor = this.editor;
    if (!editor || this.closed || this.annotator) return;
    const list = editor.paragraphs();
    const documentLang = documentLanguageOf(editor);
    const [start, end] = editor.ordered();
    const origin = from === 'documentStart' ? { paragraph: 0, offset: 0 } : { paragraph: Math.max(list.indexOf(from === 'selectionStart' ? start.paragraph : end.paragraph), 0), offset: (from === 'selectionStart' ? start : end).offset };
    // The dictionaries of the languages in the rest of the document, before the search starts.
    const languages = list.slice(origin.paragraph).map((paragraph) => paragraphLanguageOf(paragraph, documentLang));
    const dictionaries = new Map<SpellLanguage, Dictionary>();
    for (const language of new Set(languages)) if (language !== 'none') dictionaries.set(language, await loadDictionary(language));
    if (this.closed) return;
    this.spell = { issue: null };
    for (let k = origin.paragraph; k < list.length; k++) {
      const language = languages[k - origin.paragraph];
      const dictionary = language === 'none' ? undefined : dictionaries.get(language);
      if (!dictionary) continue;
      const text = paragraphText(list[k]);
      const issue = findIssues(text, { dictionary, grammar: grammar && language === 'en', ignoredRules: spelling.rules }).find((i) => k > origin.paragraph || i.start >= origin.offset);
      if (!issue) continue;
      this.spell = { issue: describeIssue(text, issue, dictionary) };
      editor.apply({ kind: 'select', paragraph: k, from: issue.start, to: issue.end });
      break;
    }
    this.reveal = true;
    this.sendSelection();
  }

  /**
   * For a request that has to see the document as the page left it when asking: null when it can be
   * answered now, otherwise what settles once the document has loaded and the commands sent before
   * the request have run. Call it as the request arrives, so later commands queue behind it.
   */
  turn(): Promise<void> | null {
    if (this.isSetUp && !this.waiting) return null;
    return new Promise((resolve) => this.later(() => this.setUp.then(resolve)));
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
      this.typedAt = performance.now();
      void this.pump();
      this.postRoomState();
    } else this.sendSelection();
  }

  private runCommand(wire: WireCommand, cjkReady = false, mathReady = false): void | Promise<void> {
    // Sent while the document is still loading: run once it has (later commands queue behind it).
    // Settings that aren't the document's take effect at once, as the first layout uses them.
    if (!this.isSetUp && !SETTINGS_COMMANDS.has(wire.kind)) return this.setUp.then(() => this.runCommand(wire, cjkReady, mathReady));
    // Formatting and pasting work on the formatted paragraph: its source is put away first, and shown again after.
    if (this.raw && (wire.kind === 'format' || wire.kind === 'pasteHtml' || wire.kind === 'applyPainter')) {
      return this.leaveRaw().then(() => Promise.resolve(this.runCommand(wire)).then(() => this.syncRaw()).then(() => this.finishRaw()));
    }
    if (wire.kind === 'format') return this.applyFormat(wire.action);
    if (wire.kind === 'applyPainter') return this.applyPainter();
    if (wire.kind === 'countWords') return this.countWords(wire.whole ?? false, wire.footer ?? false);
    if (wire.kind === 'pasteHtml') return this.pasteHtml(wire.html, wire.text);
    if (wire.kind === 'getProperties') {
      this.props = { ...this.document?.properties };
      return this.sendSelection();
    }
    if (wire.kind === 'spellWords') return acceptSpelling(wire.words ?? []).then(() => this.sendSelection());
    if (wire.kind === 'spellIgnored') {
      ignoreSpelling(wire.words, wire.rules);
      return this.sendSelection();
    }
    if (wire.kind === 'spellCheck') {
      live.spelling = wire.spelling;
      live.grammar = wire.grammar;
      return acceptSpelling(wire.words ?? []).then(() => this.sendSelection());
    }
    if (wire.kind === 'autoFormat') {
      live.autoFormat = wire.on;
      return;
    }
    if (wire.kind === 'livePreview') {
      live.livePreview = wire.on;
      return this.syncRaw().then(() => this.finishRaw());
    }
    if (wire.kind === 'spellAt') return this.spellAt(wire.page, wire.x, wire.y, wire.select ?? true);
    if (wire.kind === 'spellNext') return this.spellNext(wire.from, wire.grammar);
    if (this.annotator) return this.pdfCommand(this.annotator, wire);
    if (isPdfCommand(wire)) return;
    const editor = this.editor;
    const session = this.session;
    if (!editor || !session) return;
    // An equation needs the math font before it is laid out.
    if (!mathReady && commandHasMath(wire)) return session.ensureMath().then(() => this.runCommand(wire, cjkReady, true));
    // Typed, pasted or replaced text with characters the core font atlases lack (accents aside, symbols, East Asian text) needs its font pages before it is laid out.
    if (!cjkReady && !this.annotator) {
      const text = commandText(wire);
      if (text && /[^\u0000-\u009f]/.test(text)) return session.ensurePages(text).then(() => this.runCommand(wire, true, mathReady));
    }
    // Shown as PDF: selecting and moving only.
    if ((this.format === 'pdf' || this.readOnly) && !VIEW_COMMANDS.has(wire.kind)) return;
    // Undo, redo and Enter work on the formatted paragraph, not on its source.
    if (this.raw && (wire.kind === 'undo' || wire.kind === 'redo' || wire.kind === 'insertParagraph')) {
      return this.leaveRaw().then(() => this.runCommand(wire, cjkReady, mathReady));
    }
    if (wire.kind === 'insertParagraph' && this.endEmptyListItem(editor)) return;
    this.reveal = wire.kind !== 'pointer';
    this.commandAt = performance.now();
    // Backspace right after a shortcut turned into formatting takes it back to the characters typed.
    const converted = this.converted;
    this.converted = null;
    let edited: boolean;
    let after: void | Promise<void> = undefined;
    if (wire.kind === 'undo') edited = editor.undo().edited;
    else if (wire.kind === 'redo') edited = editor.redo().edited;
    else if (converted && wire.kind === 'delete' && wire.direction === 'backward' && wire.unit !== 'word' && editor.collapsed) {
      for (let k = 0; k < converted.steps; k++) editor.undo();
      editor.apply({ kind: 'select', paragraph: converted.paragraph, from: converted.offset, to: converted.offset });
      edited = true;
    } else if (this.raw && wire.kind === 'tab' && this.indentSource(editor, wire.backward)) {
      edited = true;
    } else {
      let command: Command;
      if (wire.kind === 'pointer') {
        const page = session.displayPages.find((p) => p.id === wire.page) ?? session.pages.find((p) => p.id === wire.page);
        if (!page) return;
        command = { ...wire, page };
      } else command = wire;
      const rule = command.kind === 'insertParagraph' ? this.lineShortcut(editor) : command.kind === 'pointer' ? this.checkboxClick(editor, command) : null;
      // A #tag at the end of the line is finished by Enter too.
      if (!rule && command.kind === 'insertParagraph') this.tagBeforeEnter(editor);
      if (rule) {
        edited = true;
        after = rule;
      } else {
        const result = editor.apply(command);
        edited = result.edited;
        if (command.kind === 'find' || command.kind === 'replaceAll') this.search = { found: result.found, replaced: result.replaced };
        if (edited && command.kind === 'insertText') after = this.typedShortcut(editor, command.text) ?? this.pastedUrl(editor, command.text);
      }
    }
    // Edits send the selection once the changed pages are laid out.
    const finish = () => {
      if (edited) this.edited = true;
      if (edited || this.rawTouched) {
        this.rawTouched = false;
        void this.pump();
        this.postRoomState();
      } else this.sendSelection();
    };
    // The caret may have come into a paragraph or left one: its source is shown or put away.
    const synced = () => (live.livePreview || this.raw ? this.syncRaw().then(finish) : finish());
    if (after) return after.then(synced);
    return synced();
  }

  // --- Live preview: the paragraph the caret is in shows its Markdown source (see livePreview.ts) -----

  /** The paragraph showing its source: what it was (to put back if nothing was changed) and the undo history before it. */
  private raw: { id: string; source: string; text: string; numbering?: NumberingReference; mark: HistoryMark } | null = null;
  /** Showing or putting away a source changed the pages. */
  private rawTouched = false;
  /** Above 0 while something works on the formatted text (the assistant): no source is shown. */
  private rawPaused = 0;

  private livePreviewCode?: Promise<typeof import('./livePreview.ts')>;
  private livePreview() {
    return (this.livePreviewCode ??= import('./livePreview.ts'));
  }

  /** Whether the paragraph at the caret may show its source: Markdown documents, edited alone. */
  private rawAllowed(): boolean {
    return live.livePreview && !this.rawPaused && this.format === 'md' && !this.annotator && !this.readOnly && !!this.editor && !this.editor.replica.connected;
  }

  /** Puts away the source of the paragraph that shows it, and shows the one the caret is in. */
  private async syncRaw(): Promise<void> {
    const editor = this.editor;
    if (!editor || this.closed) return;
    const [start, end] = editor.ordered();
    // A selection across paragraphs, or part of one the source isn't shown in, shows no source.
    const target = start.paragraph === end.paragraph ? start.paragraph : null;
    const wanted = this.rawAllowed() && target ? editor.paragraphId(target) : null;
    if (this.raw && this.raw.id === wanted) {
      // The caret moved out of the Markdown it showed (to other text of the paragraph): that is put away, and the Markdown of where the caret is shows.
      if (!editor.collapsed || !target) return;
      const code = await this.livePreview();
      if (this.closed || !this.raw || code.caretInSource(target, editor.ordered()[0].offset)) return;
    }
    if (this.raw) await this.leaveRaw();
    if (this.closed || !wanted || !target || !editor.collapsed || !this.rawAllowed()) return;
    const [at] = editor.ordered();
    if (editor.paragraphId(at.paragraph) !== wanted) return;
    await this.enterRaw(at.paragraph, at.offset);
  }

  /** Shows a paragraph as its source. */
  private async enterRaw(paragraph: Paragraph, caret: number): Promise<void> {
    const editor = this.editor;
    if (!editor || editor.inTable()) return;
    const code = await this.livePreview();
    if (this.closed) return;
    const view = code.rawView(editor.doc, paragraph, caret);
    if (!view) return;
    const mark = editor.historyMark();
    const numbering = paragraph.properties.numbering && structuredClone(paragraph.properties.numbering);
    setShowingSource(paragraph, true);
    editor.replaceParagraph(paragraph, view.properties, view.content, view.caret);
    this.raw = { id: editor.paragraphId(paragraph), source: view.source, text: view.text, ...(numbering && { numbering }), mark };
    this.rawTouched = true;
  }

  /** Puts a paragraph's source away: back to how it was if nothing changed, else read as Markdown. */
  private async leaveRaw(): Promise<void> {
    const editor = this.editor;
    const raw = this.raw;
    if (!editor || !raw) return;
    this.raw = null;
    const paragraph = editor.paragraphWithId(raw.id);
    // The paragraph is gone (joined to the one before): its text stays as it is.
    if (!paragraph) return;
    setShowingSource(paragraph, false);
    const code = await this.livePreview();
    if (this.closed) return;
    const text = paragraphText(paragraph);
    const selection = editor.selectionIds;
    // Where a position of the text shown goes in the paragraph as it is after.
    let place: (offset: number, after: string) => number;
    if (text === raw.text) {
      // Nothing was changed: as it was, and as if it had not been touched in the undo history either.
      while (editor.undoDepth > raw.mark.undo.length && editor.undo().edited);
      editor.restoreHistory(raw.mark);
      place = (offset, after) => code.visibleOffset(after, text, offset);
    } else {
      const source = code.writtenSource(editor.doc, paragraph);
      place = (offset, after) => code.visibleOffset(after, source, code.sourceOffset(text, source, offset, false));
      const parsed = await code.parseRaw(source, editor.doc, { source: raw.source, numbering: raw.numbering, properties: paragraph.properties });
      if (this.closed) return;
      editor.replaceParagraph(paragraph, parsed.properties, parsed.content, 0, parsed.define);
      // Showing the source, editing it and reading it back are one undo step.
      editor.foldHistory(raw.mark);
      this.edited = true;
    }
    // A caret or selection end in the paragraph goes to the same place in the text, not in the source.
    const shown = editor.paragraphWithId(raw.id);
    const remap = (pos: { paragraph: string; offset: number }) => (pos.paragraph === raw.id && shown ? { paragraph: pos.paragraph, offset: place(pos.offset, paragraphText(shown)) } : pos);
    editor.setSelectionIds({ anchor: remap(selection.anchor), focus: remap(selection.focus) });
    this.rawTouched = true;
  }

  /** After the source was shown or put away outside a command: lays out again. */
  private finishRaw(): void {
    if (this.rawTouched) {
      this.rawTouched = false;
      void this.pump();
      this.postRoomState();
    } else this.sendSelection();
  }

  /** Before the document is saved or exported: the source being edited is read back, so the file has the formatting (the source shows again after). */
  /** Tab and Shift+Tab in the source of a list item move the item a level (two spaces), as in Markdown. False if the caret is not in one. */
  private indentSource(editor: Editor, backward: boolean): boolean {
    const raw = this.raw;
    const paragraph = raw && editor.paragraphWithId(raw.id);
    if (!paragraph || !editor.collapsed) return false;
    const text = paragraphText(paragraph);
    if (!/^[ \t]*(?:[-*+]|\d+[.)])(?:[ \t]|$)/.test(text)) return false;
    const index = editor.paragraphs().indexOf(paragraph);
    const [at] = editor.ordered();
    const move = (from: number, to: number) => editor.apply({ kind: 'select', paragraph: index, from, to });
    let caret = at.offset;
    if (backward) {
      const spaces = Math.min(/^ */.exec(text)![0].length, 2);
      if (spaces === 0) return true;
      move(0, spaces);
      editor.apply({ kind: 'delete', direction: 'backward' });
      caret = Math.max(caret - spaces, 0);
    } else {
      move(0, 0);
      editor.apply({ kind: 'insertText', text: '  ' });
      caret += 2;
    }
    move(caret, caret);
    return true;
  }

  /** What undo and redo can do: not counting the showing of a source, which is no edit. */
  private canUndo(): boolean {
    const history = this.replica!.history;
    const raw = this.raw;
    if (!raw) return history.canUndo;
    const paragraph = this.editor?.paragraphWithId(raw.id);
    return raw.mark.undo.length > 0 || (!!paragraph && paragraphText(paragraph) !== raw.text);
  }

  private canRedo(): boolean {
    return this.raw ? this.raw.mark.redo.length > 0 : this.replica!.history.canRedo;
  }

  /**
   * Before the document is saved or exported: the source being edited is read back, so the file has the formatting.
   * Returns what puts the source back on screen, to call once the file is made.
   */
  async flushRaw(): Promise<() => void> {
    if (!this.raw) return () => {};
    this.rawPaused++;
    await new Promise<void>((resolve) =>
      this.later(async () => {
        try {
          await this.leaveRaw();
          this.finishRaw();
        } finally {
          resolve();
        }
      }),
    );
    return () => {
      this.rawPaused--;
      this.later(() => this.syncRaw().then(() => this.finishRaw()));
    };
  }

  // --- Markdown shortcuts as you type (see autoformat.ts) ---------------------------------------

  /** The last shortcut turned into formatting: the edits to undo to get the typed characters back, and the caret then. */
  private converted: { steps: number; paragraph: number; offset: number } | null = null;

  /** What shortcuts may do here: the format can express headings, lists and marks, and the caret is in plain text. */
  private shortcutContext(editor: Editor): { profile: (typeof FORMATS)[DocumentKind]; line: LineContext; code: boolean; index: number; before: string } | null {
    if (!live.autoFormat || this.raw || !editor.collapsed || this.annotator || this.readOnly) return null;
    const profile = FORMATS[this.format as DocumentKind];
    if (!profile?.editable) return null;
    const [at] = editor.ordered();
    const properties = at.paragraph.properties;
    const style = properties.style;
    return {
      profile,
      line: { styled: !!style && style !== 'Normal' && style !== 'ListParagraph', listed: !!properties.numbering?.id },
      code: style === 'Code',
      index: editor.paragraphs().indexOf(at.paragraph),
      before: paragraphText(at.paragraph).slice(0, at.offset),
    };
  }

  /** Runs formatting from the menus' actions, one edit each; fonts the formatting needs are loaded first. */
  private async formatSteps(editor: Editor, actions: Action[]): Promise<void> {
    const session = this.session;
    if (!session || !this.formats) return;
    const read = () => this.formats!.read(...editor.ordered(), editor.paragraphs(), editor.pending);
    const fonts = new Set<string>();
    for (const action of actions) formatCommand(action as FormatAction, editor, read(), fonts);
    if (fonts.size) await session.ensureFonts(fonts);
    if (this.closed) return;
    for (const action of actions) {
      const command = formatCommand(action as FormatAction, editor, read(), new Set());
      if (command) editor.apply(command);
    }
  }

  /** Plain text that is just a web address was pasted: it becomes a link. */
  private pastedUrl(editor: Editor, text: string): void {
    if (text.length < 2 || !/^https?:\/\/\S+$/i.test(text)) return;
    const context = this.shortcutContext(editor);
    if (!context || context.code || !formatAllows(context.profile, { kind: 'insertLink' } as Action)) return;
    const end = context.before.length;
    if (!context.before.endsWith(text)) return;
    const start = end - text.length;
    editor.apply({ kind: 'select', paragraph: context.index, from: start, to: end });
    editor.apply({ kind: 'setLink', url: text, text });
    editor.apply({ kind: 'select', paragraph: context.index, from: end, to: end });
    this.converted = { steps: 1, paragraph: context.index, offset: end };
  }

  /** A character was typed: if it finishes a Markdown shortcut, turns what was typed into formatting. */
  private typedShortcut(editor: Editor, typed: string): void | Promise<void> {
    if (typed.length !== 1) return;
    const context = this.shortcutContext(editor);
    if (!context) return;
    const { profile, line, code, index, before } = context;
    const end = before.length;
    const allows = (actions: Action[]) => actions.every((a) => formatAllows(profile, a));
    const select = (from: number, to: number) => editor.apply({ kind: 'select', paragraph: index, from, to });
    // A #tag is also finished by the punctuation after it (not a full stop: "#v1.2" goes on).
    if (TAG_ENDINGS.includes(typed) && !code) {
      const link = tagShortcut(before.slice(0, -1));
      if (link && allows([{ kind: 'insertLink' } as Action])) {
        select(link.start, end - 1);
        editor.apply({ kind: 'setLink', url: link.url, text: link.text });
        select(link.start + link.text.length + 1, link.start + link.text.length + 1);
        this.converted = { steps: 1, paragraph: index, offset: end };
      }
      return;
    }
    if (typed === ' ') {
      // A link (or a #tag) is made by the space after it: the text typed next then goes after the link, not into it.
      const link = code ? null : linkShortcut(before.slice(0, -1)) ?? wikiLinkShortcut(before.slice(0, -1)) ?? urlShortcut(before.slice(0, -1)) ?? tagShortcut(before.slice(0, -1));
      if (link && allows([{ kind: 'insertLink' } as Action])) {
        select(link.start, end - 1);
        editor.apply({ kind: 'setLink', url: link.url, text: link.text });
        select(link.start + link.text.length + 1, link.start + link.text.length + 1);
        this.converted = { steps: 1, paragraph: index, offset: end };
        return;
      }
      const block = blockShortcut(before, line);
      if (!block || code || !allows(block.actions)) return;
      select(end - block.remove, end);
      editor.apply({ kind: 'delete', direction: 'backward' });
      this.converted = { steps: 1 + block.actions.length, paragraph: index, offset: end };
      return this.formatSteps(editor, block.actions);
    }
    if (code) return;
    // Marked text is only closed where it does not run into the word after the caret.
    const next = paragraphText(editor.ordered()[0].paragraph).charAt(end);
    if (/[\p{L}\p{N}]/u.test(next)) return;
    const span = inlineShortcut(before);
    if (!span || !allows([{ kind: 'toggleMark', mark: span.mark }])) return;
    const inner = end - 2 * span.marker - span.start;
    if (before.slice(span.start, end).includes('\uFFFC')) return;
    select(end - span.marker, end);
    editor.apply({ kind: 'delete', direction: 'backward' });
    select(span.start, span.start + span.marker);
    editor.apply({ kind: 'delete', direction: 'backward' });
    select(span.start, span.start + inner);
    this.converted = { steps: 3, paragraph: index, offset: end };
    return this.formatSteps(editor, [{ kind: 'toggleMark', mark: span.mark }]).then(() => {
      // What is typed next is not marked.
      select(span.start + inner, span.start + inner);
      editor.apply({ kind: 'formatText', format: unmark(span.mark) });
    });
  }

  /** A click on the check box of a task list item checks or unchecks it (and puts the caret in the item). */
  private checkboxClick(editor: Editor, click: Extract<Command, { kind: 'pointer' }>): Promise<void> | null {
    if (click.extend || (click.unit && click.unit !== 'character') || this.annotator || this.readOnly) return null;
    const profile = FORMATS[this.format as DocumentKind];
    if (!profile?.editable || !profile.lists) return null;
    const hit = editor.checkboxUnder(click.page, click.x, click.y);
    if (!hit) return null;
    editor.apply({ kind: 'select', paragraph: editor.paragraphs().indexOf(hit.paragraph), from: 0, to: 0 });
    return this.formatSteps(editor, [{ kind: 'toggleList', list: hit.checked ? 'task' : 'taskDone', force: true }]);
  }

  /** Enter right after a #tag or a web address (not yet a link) makes it one, then the paragraph is split as usual. */
  private tagBeforeEnter(editor: Editor): void {
    const context = this.shortcutContext(editor);
    if (!context || context.code) return;
    const link = urlShortcut(context.before) ?? tagShortcut(context.before);
    if (!link || !formatAllows(context.profile, { kind: 'insertLink' } as Action)) return;
    const [at] = editor.ordered();
    if (editor.linkAt(at.paragraph, link.start + 1, false)) return; // already a link
    const end = context.before.length;
    editor.apply({ kind: 'select', paragraph: context.index, from: link.start, to: end });
    editor.apply({ kind: 'setLink', url: link.url, text: link.text });
    editor.apply({ kind: 'select', paragraph: context.index, from: end, to: end });
  }

  /** Enter on a line of "---" or "```": a horizontal rule or a code block instead of a new paragraph. */
  private lineShortcut(editor: Editor): Promise<void> | null {
    const context = this.shortcutContext(editor);
    if (!context) return null;
    const [at] = editor.ordered();
    const text = paragraphText(at.paragraph);
    if (at.offset !== text.length) return null;
    const kind = lineShortcut(text, context.line);
    if (!kind) return null;
    const action: Action = kind === 'rule' ? { kind: 'insertHorizontalRule' } : { kind: 'insertCodeBlock' };
    if (!formatAllows(context.profile, action)) return null;
    const { index } = context;
    editor.apply({ kind: 'select', paragraph: index, from: 0, to: text.length });
    editor.apply({ kind: 'delete', direction: 'backward' });
    this.converted = { steps: 2, paragraph: index, offset: text.length };
    return this.formatSteps(editor, [action]).then(() => {
      // A rule that took the empty line's place: the caret goes on to the line after it.
      if (kind === 'rule' && editor.ordered()[0].paragraph.properties.borders?.bottom) editor.apply({ kind: 'move', to: 'right' });
    });
  }
}

/** What finishes a #tag besides a space. */
const TAG_ENDINGS = ',;:!?)]}';

/** The change that takes a mark off what is typed next. */
function unmark(mark: Mark): RunFormat {
  switch (mark) {
    case 'bold':
      return { bold: null, boldCs: null };
    case 'italic':
      return { italic: null, italicCs: null };
    case 'strikethrough':
      return { strike: null, doubleStrike: null };
    default:
      return { style: null, fonts: null };
  }
}

/** Squiggles wait this long after the last keystroke for the word just typed. */
const SPELL_SETTLE_MS = 1000;
/** A word counts as just finished when the caret is within this many characters after it (a space, or a space and a mark). */
const SPELL_FINISHED_REACH = 2;

/** Words the user added to the dictionary (for every document), and the words and grammar rules ignored in the open document. */
const spelling = { words: new Set<string>(), ignoredWords: new Set<string>(), rules: new Set<string>() };
/** What is underlined as the user types. */
const live = { spelling: true, grammar: true, autoFormat: true, livePreview: false };
const dictionaries = new Map<SpellLanguage, Promise<Dictionary>>();
const loadedDictionaries = new Map<SpellLanguage, Dictionary>();
/** Changes when what counts as a mistake does, so checked paragraphs are checked again. */
let spellVersion = 0;
const checked = new WeakMap<object, { text: string; version: number; documentLang: SpellLanguage | Unchecked; issues: TextIssue[] }>();

/** The language a document is in, for text that doesn't say: kept while its beginning is unchanged. */
const documentLanguages = new WeakMap<Editor, { declared: string | undefined; sample: string; locale: string; language: SpellLanguage | Unchecked }>();

function documentLanguageOf(editor: Editor): SpellLanguage | Unchecked {
  const declared = editor.doc.styles.defaultRunProperties?.lang?.val;
  let sample = '';
  for (const paragraph of editor.paragraphs()) {
    sample += `${paragraphText(paragraph)}\n`;
    if (sample.length >= 4000) break;
  }
  const locale = getLocale();
  const known = documentLanguages.get(editor);
  if (known && known.declared === declared && known.sample === sample && known.locale === locale) return known.language;
  const language = documentLanguage(declared, () => sample, locale);
  documentLanguages.set(editor, { declared, sample, locale, language });
  return language;
}

/** The language of a paragraph (see spelling/languages.ts). */
function paragraphLanguageOf(paragraph: Parameters<typeof paragraphText>[0], documentLang: SpellLanguage | Unchecked, text = paragraphText(paragraph)): SpellLanguage | Unchecked {
  return paragraphLanguage(runPropertiesAt(paragraph, 0)?.lang?.val, text, documentLang);
}

/**
 * What is wrong in a paragraph: kept until its text (or what counts as wrong) changes. A paragraph
 * in a language whose dictionary isn't loaded yet has nothing wrong for now, and `needs` says so.
 */
function issuesOf(paragraph: Parameters<typeof paragraphText>[0], documentLang: SpellLanguage | Unchecked, needs: (language: SpellLanguage) => void): TextIssue[] {
  const text = paragraphText(paragraph);
  const known = checked.get(paragraph);
  if (known && known.text === text && known.version === spellVersion && known.documentLang === documentLang) return known.issues;
  const language = paragraphLanguageOf(paragraph, documentLang, text);
  if (language === 'none') return [];
  const dictionary = loadedDictionaries.get(language);
  if (!dictionary) {
    needs(language);
    return [];
  }
  const issues = checkText(text, language, dictionary, live);
  checked.set(paragraph, { text, version: spellVersion, documentLang, issues });
  return issues;
}

/** What is wrong in a text, with the dictionary of its language (the grammar rules are English). */
function checkText(text: string, language: SpellLanguage, dictionary: Dictionary, what: { spelling: boolean; grammar: boolean }): TextIssue[] {
  return findIssues(text, { dictionary, grammar: what.grammar && language === 'en', ignoredRules: spelling.rules }).filter((i) => what.spelling || i.kind !== 'spelling');
}

/** Answers a `spellText`: the lines are checked in their own languages (the file's, unless a line says another), once the dictionaries are in. */
async function spellText(message: Extract<ToWorker, { type: 'spellText' }>): Promise<void> {
  const documentLang = documentLanguage(undefined, () => message.sample, getLocale());
  const languages = message.texts.map((text) => paragraphLanguage(undefined, text, documentLang));
  let loading = false;
  for (const language of new Set(languages)) {
    if (language === 'none' || loadedDictionaries.has(language)) continue;
    try {
      await loadDictionary(language);
    } catch {
      loading = true;
    }
  }
  const issuesAt = (index: number): { issues: TextIssue[]; dictionary: Dictionary | null } => {
    const language = languages[index];
    const dictionary = language === 'none' ? null : (loadedDictionaries.get(language) ?? null);
    return { dictionary, issues: dictionary && language !== 'none' ? checkText(message.texts[index], language, dictionary, message) : [] };
  };
  if (message.at) {
    const { issues, dictionary } = issuesAt(message.at.index);
    const text = message.texts[message.at.index];
    const issue = issues.find((i) => i.start <= message.at!.offset && message.at!.offset <= i.end);
    post({ type: 'spellText', request: message.request, marks: [], issue: issue && dictionary ? describeIssue(text, issue, dictionary) : null, loading });
    return;
  }
  const marks = message.texts.map((_, i) => issuesAt(i).issues.map((m): TextMark => ({ start: m.start, end: m.end, kind: m.kind === 'spelling' ? 0 : 1 })));
  post({ type: 'spellText', request: message.request, marks, issue: null, loading });
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

/** A language's dictionary, read the first time something in it is checked. */
function loadDictionary(language: SpellLanguage): Promise<Dictionary> {
  let load = dictionaries.get(language);
  if (!load) {
    load = readDictionary(language).catch((error: unknown) => {
      // Try again next time.
      dictionaries.delete(language);
      throw error;
    });
    dictionaries.set(language, load);
  }
  return load;
}

async function readDictionary(language: SpellLanguage): Promise<Dictionary> {
  const file = DICTIONARY_FILES[language];
  const [aff, dic] = await Promise.all([fetch(`${DICTIONARY_BASE}${file}.aff`), fetch(`${DICTIONARY_BASE}${file}.dic`)]);
  if (!aff.ok || !dic.ok) throw new Error('the dictionary could not be loaded');
  const affix = new Uint8Array(await aff.arrayBuffer());
  // Some dictionaries are not UTF-8 (German is ISO 8859-1): the .aff says which.
  const decoder = new TextDecoder(affixEncoding(affix));
  const dictionary = Dictionary.parse(decoder.decode(affix), decoder.decode(await dic.arrayBuffer()), { smallWords: language === 'en' ? ENGLISH_SMALL_WORDS : undefined });
  dictionary.accept(...APP_WORDS[language], ...spelling.words);
  dictionary.setIgnored([...spelling.ignoredWords]);
  loadedDictionaries.set(language, dictionary);
  return dictionary;
}

/** Words to treat as spelled correctly in every document, from now on. */
async function acceptSpelling(words: string[]): Promise<void> {
  for (const word of words) spelling.words.add(word);
  spellVersion++;
  for (const dictionary of loadedDictionaries.values()) dictionary.accept(...words);
  // A dictionary still being read takes them when it is done (it reads `spelling.words`).
}

/** What is ignored in the open document, instead of what was ignored in the one before. */
function ignoreSpelling(words: string[], rules: string[]): void {
  spelling.ignoredWords = new Set(words);
  spelling.rules = new Set(rules);
  spellVersion++;
  for (const dictionary of loadedDictionaries.values()) dictionary.setIgnored(words);
  // A dictionary still being read takes them when it is done (it reads `spelling.ignoredWords`).
}

let current: OpenDocument | null = null;

/**
 * Opens a document. Everything up to the first `await` happens at once, as the message is handled:
 * `current` is the new document from then on, so the messages sent after this one find it.
 */
async function open(doc: number, source: DocumentSource, requestedRoom?: RoomOptions, keepRoom?: boolean, version?: number): Promise<void> {
  // The same picture or drawing, changed: it keeps its room (when alone in it) rather than leaving and joining again.
  const carried = keepRoom ? (current?.handOverRoom() ?? null) : null;
  current?.leave();
  current?.controller.abort();
  const entry = new OpenDocument(doc);
  current = entry;
  // What was ignored in the document before is not ignored in this one (the page sends its own once it is open).
  ignoreSpelling([], []);
  if (carried) entry.takeRoom(carried);
  // It could not keep it (it was being handed over): the page joins again once the document is next saved.
  else if (keepRoom) post({ type: 'roomGone', doc });
  try {
    const fonts = await fontsReady;
    const t0 = performance.now();
    const loaded = await load(source, fonts);
    if (entry.closed) return;
    // In a room the first person's embeds go to the others with the document (a picture's bytes are in the file the room starts from).
    if (loaded.document && loaded.lens === 'md') {
      await showEmbeds(loaded.document, fonts);
      if (entry.closed) return;
    }
    entry.format = loaded.lens;
    entry.origin = loaded.origin;
    entry.extensions = loaded.extensions;
    entry.original = loaded.original;
    entry.pagesCurrent = loaded.pagesCurrent;
    const name = loaded.name;
    // Shown as PDF: the original's own pages, even when its text has since been edited as
    // something else (the page is told, to say that the edits aren't on them).
    if (loaded.lens === 'pdf' && loaded.original) {
      const pdfClient = carried?.clientId ?? crypto.randomUUID().slice(0, 8);
      const pdfRoom = carried ? undefined : requestedRoom;
      // Others in the room: the pages open from the room's file, not ours.
      let source = loaded;
      let start: RoomStart | null = null;
      if (pdfRoom) {
        start = await entry.joinWithin(pdfRoom, pdfClient, OPEN_JOIN_MS);
        if (entry.closed) return;
        if (start?.kind === 'room') source = await load({ kind: 'wdoc', name: loaded.name, bytes: start.bytes.slice().buffer }, fonts);
      }
      return await openPdf(entry, source, fonts, t0, { start, client: pdfClient, ...(carried && { version: version ?? null }) });
    }
    // A PDF edited as anything else is reflowed into a flowing document the first time.
    let document = loaded.document ?? (await reflow(loaded.original!, loaded.extensions));
    // Rooms share the document itself, so any format edited through it can be in one. A picture is the exception: its pixels are not
    // edited together, but the shapes drawn over it (its layers) are, in a room of their own kind.
    const layered = isLayeredFormat(entry.format);
    const room = carried ? undefined : requestedRoom;
    const readMs = performance.now() - t0;
    if (entry.closed) return;
    const clientId = carried?.clientId ?? crypto.randomUUID().slice(0, 8);
    // The room's document says what everyone edits it as (a person who joined by a link starts from a blank Word one).
    const adopt = async (shared: { lens: Format; origin: Format; extensions: Extensions }, from: WordDocument): Promise<void> => {
      entry.format = shared.lens;
      entry.origin = shared.origin;
      entry.extensions = await withDrawingText(from, shared.lens, shared.extensions);
    };
    let start: RoomStart | null = null;
    if (room) {
      start = await entry.joinWithin(room, clientId, OPEN_JOIN_MS);
      if (entry.closed) return;
      if (start?.kind === 'room') {
        if (layered) {
          // A picture's or drawing's room: everyone starts from the room's copy of the picture and its shapes.
          const shared = await load({ kind: 'wdoc', name, bytes: start.bytes.slice().buffer }, fonts);
          document = shared.document!;
          entry.extensions = shared.extensions;
        } else {
          // Someone else is already editing: everyone starts from the room's copy, not ours.
          const shared = await readRoomDocument(start.bytes);
          document = await WordDocument.read(shared.docx);
          await adopt(shared, document);
        }
      }
    }
    // Operations need paragraph ids and normalized content: set up before layout sees the document.
    const replica = new Replica(document, { clientId });
    const session = await LayoutSession.create(document, fonts);
    if (entry.closed) return;
    entry.document = document;
    // A picture another person added is fetched from the room when it is first needed.
    document.fetchPart = (part) => entry.fetchRoomMedia(part);
    entry.replica = replica;
    entry.session = session;
    entry.editor = new Editor(replica, session);
    entry.formats = new FormatReader(document);
    // A picture's shapes (its layers), or the nodes of a drawing others are editing, are set up before the room's messages are handled.
    if (isPictureFormat(entry.format)) await entry.setupLayers(clientId);
    else if (isVectorFormat(entry.format) && start?.kind === 'room') await entry.ensureVector();
    entry.ready();
    if (start) entry.net!.ready(start);
    // Opened again in place of itself (watching, it was saved): the room may let it be changed now.
    if (carried) entry.net?.refreshed(version);
    post({ type: 'opened', doc, name, format: entry.format, annotating: false, outdated: false });
    if (entry.layers) entry.postShapes();
    // The drawing's nodes have ids of their own now: the editor is given them, so that what it changes is named as the room names it.
    if (entry.vectorLayers) entry.postVector(true);
    await entry.pump();
    if (entry.closed) return;
    post({ type: 'done', doc, pages: session.pages.length, timings: { read: readMs, ...session.timings } });
  } catch (e) {
    if (entry.closed) return;
    console.error(e);
    post({ type: 'error', doc, message: (e as Error).message });
  } finally {
    // Failed, or stopped for another: what waits on it is answered as for no document.
    entry.setUpDone();
  }
}

/** Opens a PDF's own pages for marking up, in a room (`options.start`) if it is in one: the file it opens from is the room's. */
async function openPdf(
  entry: OpenDocument,
  source: Loaded,
  fonts: FontSet,
  t0: number,
  options: { start: RoomStart | null; client: string; /** Opened again in place of itself (see `open`): the version it is. */ version?: number | null },
): Promise<void> {
  const { openPdfView, PdfAnnotator } = await import('../formats/handlers/pdf.ts');
  const view = await openPdfView(source.original!, fonts, { annotations: source.extensions.pdf?.annotations, fields: source.extensions.pdf?.fields, edits: source.extensions.pdf?.edits, editFonts: await editFontsFor(fonts) });
  const readMs = performance.now() - t0;
  if (entry.closed) return;
  // What it is edited as comes from the file it opens from (a person who joined by a link starts as Word).
  entry.format = source.lens;
  entry.origin = source.origin;
  entry.extensions = source.extensions;
  entry.original = source.original;
  entry.pagesCurrent = source.pagesCurrent;
  entry.document = source.document; // kept as it is, for saving
  entry.pdf = { view, bytes: source.original! };
  const annotator = new PdfAnnotator(view, undefined, source.original);
  entry.annotator = annotator;
  entry.ready();
  if (options.start) entry.net!.ready(options.start);
  if (options.version !== undefined) entry.net?.refreshed(options.version ?? undefined);
  post({ type: 'opened', doc: entry.doc, name: source.name, format: 'pdf', annotating: true, outdated: !!source.document && !source.pagesCurrent });
  const bodyMs = await entry.pumpPdf();
  if (entry.closed) return;
  post({ type: 'done', doc: entry.doc, pages: view.pageCount, timings: { read: readMs, fonts: 0, body: bodyMs, headers: 0 } });
}

async function media(doc: number, request: number, part: string): Promise<void> {
  let bytes: ArrayBuffer | null = null;
  try {
    const open = current?.doc === doc ? current : null;
    // After the document has loaded and the commands sent before (a picture just put in) have run.
    const turn = open?.turn();
    if (turn) await turn;
    if (open?.pdf) bytes = (await open.pdf.view.media(part))?.slice().buffer ?? null;
    else if (open?.document) bytes = (await open.document.media(part)).slice().buffer;
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

/** The time now as a document property (W3CDTF, to the second, in UTC). */
const now = (): string => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/** The whole open document as a .wdoc, to be edited as `lens` (default: as now) when next opened. */
async function save(doc: number, request: number, lens?: Format): Promise<void> {
  try {
    const open = current;
    // Asked for while the document was loading, or with commands still to run: once they have.
    const turn = open?.doc === doc ? open.turn() : null;
    if (turn) await turn;
    if (open?.doc !== doc || (!open.document && !open.original)) throw new Error(t('app.documentNotOpen'));
    const resume = await open.flushRaw();
    // Pictures others added that haven't been needed yet are brought in, so the file holds them all.
    await open.document?.fetchMissingMedia();
    // A document changed since it was opened records when.
    if (open.document && open.edited) open.document.properties.modified = now();
    let bytes: Uint8Array;
    try {
      bytes = await writeWdoc({
        manifest: { version: WDOC_VERSION, lens: lens ?? open.format, origin: open.origin, pagesCurrent: open.pagesCurrent && !open.edited },
        document: open.document ? await open.document.write() : null,
        original: open.original,
        extensions: currentExtensions(open),
      });
    } finally {
      resume();
    }
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
    // Asked for while the document was loading, or with commands still to run: once they have.
    const turn = open?.doc === doc ? open.turn() : null;
    if (turn) await turn;
    if (open?.doc !== doc || (!open.document && !open.original)) throw new Error(t('app.documentNotOpen'));
    const resume = await open.flushRaw();
    let bytes: Uint8Array;
    try {
      // A PDF whose text wasn't edited exports as the original, pages and all.
      await open.document?.fetchMissingMedia();
      if (to === 'pdf' && open.original && (!open.document || (open.pagesCurrent && !open.edited))) bytes = await annotatedPdf(open.original, currentExtensions(open));
      else bytes = await exportDocument(open.document ?? (await reflow(open.original!, currentExtensions(open))), open.extensions, to, await fontsReady);
    } finally {
      resume();
    }
    const buffer = bytes.slice().buffer;
    post({ type: 'saved', request, bytes: buffer }, [buffer]);
  } catch (e) {
    post({ type: 'saved', request, bytes: null, error: (e as Error).message });
  }
}

/** The open picture's own file, without the shapes drawn over it, answered like an export. */
async function pictureBase(doc: number, request: number): Promise<void> {
  try {
    const open = current;
    if (open?.doc !== doc || !open.document) throw new Error(t('app.documentNotOpen'));
    const picture = await (await import('../formats/imageDoc.ts')).firstPicture(open.document);
    if (!picture) throw new Error(t('app.notImage'));
    const buffer = picture.image.bytes.slice().buffer;
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

// A failure nothing is waiting on (a layout pass after an edit, say) is still reported: otherwise the
// pages would just stop changing, with nothing said.
self.onunhandledrejection = (event: PromiseRejectionEvent) => {
  console.error(event.reason);
  if (current && !current.closed) post({ type: 'error', doc: current.doc, message: event.reason instanceof Error ? event.reason.message : String(event.reason) });
};

/** Messages from the page not handled yet, in the order they were sent. */
const inbox: ToWorker[] = [];
/** An `open` is waiting for the page's language: the messages after it wait with it. */
let held = false;

self.onmessage = (event: MessageEvent<ToWorker>) => {
  inbox.push(event.data);
  if (!held) handleInbox();
};

/**
 * Handles the page's messages strictly in the order they were sent. Only the start of an `open`
 * holds the others up (see `open`): its loading and layout go on while later messages are handled,
 * and those for the new document find it, waiting for it to load where they need it.
 */
function handleInbox(): void {
  while (!held && inbox.length) {
    const message = inbox.shift()!;
    if (message.type === 'open') {
      // After the language (at start-up), so the document's errors and name are in it. A language
      // that failed to load leaves English, rather than the document never opening.
      held = true;
      void localeReady
        .catch(() => {})
        .then(() => {
          held = false;
          void open(message.doc, message.source, message.room, message.keepRoom, message.version);
          handleInbox();
        });
    } else {
      try {
        handle(message);
      } catch (e) {
        // One message going wrong mustn't stop the ones after it.
        console.error(e);
      }
    }
  }
}

function handle(message: Exclude<ToWorker, { type: 'open' }>): void {
  switch (message.type) {
    case 'locale':
      localeReady = loadLocale(message.locale).then(setCjkLang);
      break;
    case 'pointer':
      if (current?.doc === message.doc) current.sendPointer(message.pointer);
      break;
    case 'joinRoom':
      if (current?.doc === message.doc) void current.joinLate(message.room);
      break;
    case 'takeOver':
      if (current?.doc === message.doc) current.takeOver();
      break;
    case 'roomReleased':
      if (current?.doc === message.doc) current.released();
      break;
    case 'leave':
      current?.leave();
      break;
    case 'close':
      current?.leave();
      current?.controller.abort();
      current = null;
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
    case 'embedFile':
      embedAnswers.get(message.request)?.(message.file);
      break;
    case 'spellText':
      void spellText(message).catch((e: unknown) => {
        console.error(e);
        post({ type: 'spellText', request: message.request, marks: [], issue: null, loading: false });
      });
      break;
    case 'linkAt':
      post({ type: 'linkAt', request: message.request, ...(current?.doc === message.doc ? current.linkAt(message.page, message.x, message.y) : { url: null, checkbox: false }) });
      break;
    case 'command':
      // The settings are the worker's own (the dictionary, what is underlined), so they hold with no document open.
      if (current?.doc !== message.doc && SETTINGS_COMMANDS.has(message.command.kind)) applySettings(message.command);
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
    case 'shapes':
      if (current?.doc === message.doc) current.setShapes(message.shapes, message.base);
      break;
    case 'shapesStep':
      if (current?.doc === message.doc) current.stepShapes(message.action);
      break;
    case 'vectorScene':
      if (current?.doc === message.doc) current.setVectorScene(message.scene, message.base);
      break;
    case 'vectorStep':
      if (current?.doc === message.doc) current.stepVector(message.action);
      break;
    case 'putDrawing':
      if (current?.doc === message.doc) current.putDrawing(message.svg, new Uint8Array(message.png), message.width, message.height, message.description, message.replace);
      break;
    case 'save':
      void save(message.doc, message.request, message.lens);
      break;
    case 'convert':
      void exportAs(message.doc, message.request, message.to);
      break;
    case 'pictureBase':
      void pictureBase(message.doc, message.request);
      break;
    case 'agent':
      // Always answered, even if the tool fails: the page waits for it.
      const shown: string[] = [];
      void (current?.doc === message.doc ? current.agent(message.name, message.args, (images) => shown.push(...images)) : Promise.resolve('Error: no document is open.'))
        .catch((e: unknown) => {
          console.error(e);
          return 'Error: that did not work.';
        })
        .then((result) => post({ type: 'agentResult', request: message.request, result, ...(shown.length && { images: shown }) }));
      break;
  }
}

/** #rrggbb as RGB 0–1. */
function parseHex(css: string): [number, number, number] | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(css);
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
