// The layout worker: owns the open document, lays it out, applies edits and streams pages
// (as transferable GPU-ready buffers) and selection geometry to the page. Everything heavy
// happens here, so the page keeps rendering and responding while a document lays out.

import { WordDocument } from '@word/docx';
import { Editor, type Command } from '@word/editor';
import { Replica, type Pointer, type Selection as OpSelection, type Transaction } from '@word/ops';
import type { RoomClientMessage, RoomServerMessage } from '../collab/messages.ts';
import { RoomClient, type RoomHost, type RoomStart, type SocketLike } from '../collab/roomClient.ts';
import {
  describeFace,
  encodePage,
  FontSet,
  LayoutSession,
  type EncodedPage,
  PageLayout,
  type FaceDescriptor,
} from '@word/layout';
import { exportDocument, importDocument, type Format } from '../formats/convert.ts';
import { pdfToDocument } from '../formats/pdfImport.ts';
import { openPdfView, type PdfView } from '../formats/pdfPages.ts';
import { readWdoc, WDOC_VERSION, writeWdoc, type Extensions } from '../formats/wdoc.ts';
import { PdfDocument, applyAnnotations, applyFields, readAnnotations, type FormField } from '@word/pdf';
import { markupToDocument } from '../formats/pdfMarkup.ts';
import { PdfAnnotator } from './pdfAnnotator.ts';
import { FONT_BASE, type DocumentSource, type FromWorker, type LayoutUpdate, type RoomOptions, type SelectionUpdate, type ToWorker, type WireCommand, type WireField } from './protocol.ts';
import { fontShowcase, plainTextDocument } from './samples.ts';
import welcomeText from './welcome.md?raw';
import { FormatReader } from './selectionFormat.ts';
import { formatCommand, type FormatAction } from './formatting.ts';

/** Milliseconds of layout between updates: small enough that the first pages show quickly. */
const SLICE_MS = 12;
/** Longest selection text kept for the clipboard. */
const CLIPBOARD_LIMIT = 4_000_000;

const fontsReady = FontSet.load(async (path) => {
  const response = await fetch(FONT_BASE + path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}. Run \`pnpm fonts\`.`);
  return response.json();
});

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
    case 'html':
    case 'txt': {
      const { document, extensions } = await importDocument(source.kind, new Uint8Array(source.bytes));
      return flowing(source.name, document, source.kind, extensions);
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
    case 'blank':
      return flowing(source.name, await WordDocument.create());
    case 'fonts':
      return flowing('Fonts', await fontShowcase(fonts));
    case 'welcome': {
      // Written in Markdown for easy editing, then opened as an ordinary (Word) document.
      const { document, extensions } = await importDocument('md', new TextEncoder().encode(welcomeText));
      return flowing('Welcome to Golem Docs', document, 'docx', extensions);
    }
  }
}

/** Commands that only look: allowed on a document shown as PDF, which can't be edited. */
const VIEW_COMMANDS = new Set<WireCommand['kind']>(['pointer', 'move', 'selectAll']);

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

  constructor(readonly doc: number) {}

  get closed(): boolean {
    return this.controller.signal.aborted;
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
    this.nextPdfPageId = view.pageCount;
    for (let i = 0; i < view.pageCount && !this.closed; i++) {
      let page: PageLayout;
      try {
        page = view.layoutPage(i);
      } catch (e) {
        // One unreadable page mustn't lose the rest: show it blank.
        console.error(e);
        page = new PageLayout(i, 612, 792, 0, i + 1);
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
    if (selection) transfer.push(selection.rects.buffer, selection.commentRects.buffer);
    const update: LayoutUpdate = { faces, pages, overlays, order, drop, selection };
    post({ type: 'layout', doc: this.doc, ...update }, transfer);
  }

  sendSelection(): void {
    const selection = this.selection();
    if (selection) post({ type: 'selection', doc: this.doc, ...selection }, [selection.rects.buffer, selection.commentRects.buffer]);
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
      comments: commented.map((c) => ({ id: c.id, author: c.author, date: c.date, text: c.text, page: c.rects[0]?.page.id ?? null, y: c.rects[0]?.y ?? 0 })),
      commentRects,
      focus: caret(g.focus),
      reveal: this.reveal,
      text: editor.selectedText(CLIPBOARD_LIMIT),
      format: this.formats!.read(...editor.ordered(), editor.paragraphs(), editor.pending),
      canUndo: this.replica!.history.canUndo,
      canRedo: this.replica!.history.canRedo,
      workerMs: this.commandAt ? performance.now() - this.commandAt : 0,
      remote,
      remoteRects,
    };
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
    const update: SelectionUpdate = {
      caret: null,
      rects: packed,
      comments: [],
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
      fields: annotator.fields.map((f) => this.wireField(f)).filter((f) => f !== null),
    };
    this.reveal = false;
    this.commandAt = 0;
    return update;
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
        if (index >= 0) annotator.pointer(index, wire.x, wire.y, wire.extend ?? false, wire.unit ?? 'character');
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
      case 'undo':
        changed = annotator.undo();
        break;
      case 'redo':
        changed = annotator.redo();
        break;
      default:
        return;
    }
    if (changed.length) this.relayoutPdf(changed);
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
   * Joins the room for a document that was already open (a new one, once it has been uploaded). Only
   * when nobody else is editing it: otherwise the room's document would replace this one, which
   * can't be done under the user, so it carries on unshared and is merged as a separate copy later.
   */
  async joinLate(room: Extract<RoomOptions, { kind: 'network' }>): Promise<void> {
    if (this.net || this.room || this.format !== 'docx' || !this.replica || !this.editor) return;
    const start = await this.joinNetwork(room, this.replica.clientId);
    if (this.closed || !start) return;
    if (start.kind === 'own') this.net!.ready(start);
    else {
      this.net!.leave();
      this.net = null;
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

  /** Commands waiting for fonts a formatting command needs; later ones queue behind it. */
  private waiting: Promise<void> | null = null;

  command(wire: WireCommand): void {
    if (this.waiting) return this.later(() => this.runCommand(wire));
    const done = this.runCommand(wire);
    if (done) this.later(() => done);
  }

  /** Formatting from the menus and toolbars. One that starts using a font loads its faces first. */
  private applyFormat(action: FormatAction): void | Promise<void> {
    const { editor, session } = this;
    if (!editor || !session || this.annotator || this.readOnly) return;
    const fonts = new Set<string>();
    const command = formatCommand(action, editor, this.formats!.read(...editor.ordered(), editor.paragraphs(), editor.pending), fonts);
    if (!command) return;
    if (fonts.size) return session.ensureFonts(fonts).then(() => this.apply(command));
    this.apply(command);
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

  private runCommand(wire: WireCommand): void | Promise<void> {
    if (wire.kind === 'format') return this.applyFormat(wire.action);
    if (this.annotator) return this.pdfCommand(this.annotator, wire);
    if (wire.kind === 'annotate' || wire.kind === 'setFields') return;
    const editor = this.editor;
    const session = this.session;
    if (!editor || !session) return;
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
      edited = editor.apply(command).edited;
    }
    // Edits send the selection once the changed pages are laid out.
    if (edited) {
      this.edited = true;
      void this.pump();
      this.status();
    } else this.sendSelection();
  }
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
      const view = await openPdfView(loaded.original, fonts, { annotations: loaded.extensions.pdf?.annotations, fields: loaded.extensions.pdf?.fields });
      const readMs = performance.now() - t0;
      if (entry.closed) return;
      entry.document = loaded.document; // kept as it is, for saving
      entry.pdf = { view, bytes: loaded.original };
      entry.annotator = new PdfAnnotator(view);
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
  const document = await pdfToDocument(original);
  const pdf = PdfDocument.load(original);
  markupToDocument(document, pdf, extensions.pdf?.annotations ?? readAnnotations(pdf));
  return document;
}

/** The document's extensions, with the PDF's annotations and form fields as they are now when its pages are shown. */
function currentExtensions(open: OpenDocument): Extensions {
  if (!open.annotator) return open.extensions;
  return { ...open.extensions, pdf: { annotations: [...open.annotator.annotations], fields: [...open.annotator.fields] } };
}

/**
 * The original PDF with the document's annotations and form fields written in as an incremental
 * update (the original bytes, then the changes), or the original itself when it has neither layer.
 */
async function annotatedPdf(original: Uint8Array, extensions: Extensions): Promise<Uint8Array> {
  const { annotations, fields } = extensions.pdf ?? {};
  if (!annotations && !fields) return original.slice();
  const doc = PdfDocument.load(original);
  if (annotations) applyAnnotations(doc, annotations);
  if (fields) applyFields(doc, fields);
  return doc.save({ incremental: true });
}

/** The whole open document as a .wdoc, to be edited as `lens` (default: as now) when next opened. */
async function save(doc: number, request: number, lens?: Format): Promise<void> {
  try {
    const open = current;
    if (open?.doc !== doc || (!open.document && !open.original)) throw new Error('no document');
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

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case 'open':
      void open(message.doc, message.source, message.room);
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
    case 'media':
      void media(message.doc, message.request, message.part);
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
    case 'save':
      void save(message.doc, message.request, message.lens);
      break;
    case 'convert':
      void exportAs(message.doc, message.request, message.to);
      break;
  }
};
