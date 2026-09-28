// The layout worker: owns the open document, lays it out, applies edits and streams pages
// (as transferable GPU-ready buffers) and selection geometry to the page. Everything heavy
// happens here, so the page keeps rendering and responding while a document lays out.

import { WordDocument } from '@word/docx';
import { Editor, type Command } from '@word/editor';
import {
  describeFace,
  encodePage,
  FontSet,
  LayoutSession,
  type EncodedPage,
  type FaceDescriptor,
  type PageLayout,
} from '@word/layout';
import { FONT_BASE, type DocumentSource, type FromWorker, type LayoutUpdate, type SelectionUpdate, type ToWorker, type WireCommand } from './protocol.ts';
import { fontShowcase, plainTextDocument } from './samples.ts';

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

async function read(source: DocumentSource, fonts: FontSet): Promise<{ name: string; document: WordDocument }> {
  switch (source.kind) {
    case 'docx':
      return { name: source.name, document: await WordDocument.read(new Uint8Array(source.bytes)) };
    case 'docx-url':
      return { name: source.name, document: await WordDocument.read(new Uint8Array(await (await fetchOk(source.url)).arrayBuffer())) };
    case 'text-url':
      return { name: source.name, document: await plainTextDocument(await (await fetchOk(source.url)).text()) };
    case 'fonts':
      return { name: 'Fonts', document: await fontShowcase(fonts) };
  }
}

/** Faces the page already has (it keeps them across documents). */
const sentFaces = new Set<string>();

class OpenDocument {
  document: WordDocument | null = null;
  session: LayoutSession | null = null;
  editor: Editor | null = null;
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

  /** Sends new pages, overlays and the page order. */
  private flush(): void {
    const session = this.session!;
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
    const display = session.displayPages;
    const keep = new Set<number>();
    for (const page of display) keep.add(page.id);
    for (const page of session.pages) keep.add(page.id);

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
    if (selection) transfer.push(selection.rects.buffer);
    const update: LayoutUpdate = { faces, pages, overlays, order, drop, selection };
    post({ type: 'layout', doc: this.doc, ...update }, transfer);
  }

  sendSelection(): void {
    const selection = this.selection();
    if (selection) post({ type: 'selection', doc: this.doc, ...selection }, [selection.rects.buffer]);
  }

  private selection(): SelectionUpdate | undefined {
    const editor = this.editor;
    if (!editor || this.closed) return undefined;
    const g = editor.geometry();
    const caret = (c: typeof g.caret) => (c ? { page: c.page.id, x: c.x, y: c.y, height: c.height } : null);
    const rects = new Float64Array(g.rects.length * 5);
    g.rects.forEach((r, i) => rects.set([r.page.id, r.x, r.y, r.width, r.height], i * 5));
    const update: SelectionUpdate = {
      caret: caret(g.caret),
      rects,
      focus: caret(g.focus),
      reveal: this.reveal,
      text: editor.selectedText(CLIPBOARD_LIMIT),
      workerMs: this.commandAt ? performance.now() - this.commandAt : 0,
    };
    this.reveal = false;
    this.commandAt = 0;
    return update;
  }

  command(wire: WireCommand): void {
    const editor = this.editor;
    const session = this.session;
    if (!editor || !session) return;
    let command: Command;
    if (wire.kind === 'pointer') {
      const page = session.displayPages.find((p) => p.id === wire.page) ?? session.pages.find((p) => p.id === wire.page);
      if (!page) return;
      command = { ...wire, page };
    } else command = wire;
    this.reveal = wire.kind !== 'pointer';
    this.commandAt = performance.now();
    const { edited } = editor.apply(command);
    // Edits send the selection once the changed pages are laid out.
    if (edited) void this.pump();
    else this.sendSelection();
  }
}

let current: OpenDocument | null = null;

async function open(doc: number, source: DocumentSource): Promise<void> {
  current?.controller.abort();
  const entry = new OpenDocument(doc);
  current = entry;
  try {
    const fonts = await fontsReady;
    const t0 = performance.now();
    const { name, document } = await read(source, fonts);
    const readMs = performance.now() - t0;
    if (entry.closed) return;
    const session = await LayoutSession.create(document, fonts);
    if (entry.closed) return;
    entry.document = document;
    entry.session = session;
    entry.editor = new Editor(document, session);
    post({ type: 'opened', doc, name });
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
    if (current?.doc === doc && current.document) bytes = (await current.document.media(part)).slice().buffer;
  } catch {
    bytes = null;
  }
  post({ type: 'media', request, bytes }, bytes ? [bytes] : []);
}

async function save(doc: number, request: number): Promise<void> {
  try {
    if (current?.doc !== doc || !current.document) throw new Error('no document');
    const bytes = (await current.document.write()).slice().buffer;
    post({ type: 'saved', request, bytes }, [bytes]);
  } catch (e) {
    post({ type: 'saved', request, bytes: null, error: (e as Error).message });
  }
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case 'open':
      void open(message.doc, message.source);
      break;
    case 'media':
      void media(message.doc, message.request, message.part);
      break;
    case 'command':
      if (current?.doc === message.doc) current.command(message.command);
      break;
    case 'save':
      void save(message.doc, message.request);
      break;
  }
};
