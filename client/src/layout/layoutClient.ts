import type { Shape } from '../formats/imageDraw.ts';
import type { Scene } from '../vector/model.ts';
import type { FaceDescriptor } from '@golemdocs/layout';
import type { Pointer } from '@golemdocs/ops';
import type { Format } from '../formats/convert.ts';
import { t } from '../i18n/index.ts';
import type { DocumentSource, FromWorker, LayoutTimings, LayoutUpdate, RoomOptions, RoomState, SelectionUpdate, SpellIssue, TextMark, ToWorker, WireCommand } from './protocol.ts';

/** Callbacks for one document. None fire after another document is opened. */
export interface DocumentListener {
  /** `format`: what the document is edited as; `annotating`: a PDF's own pages, which take markup annotations. */
  opened(name: string, format: Format, annotating: boolean, outdated: boolean): void;
  layout(update: LayoutUpdate): void;
  /** The first full layout finished. */
  done(pages: number, timings: LayoutTimings): void;
  selection(update: SelectionUpdate): void;
  /** Collaboration status (documents opened in a room). */
  /** The multiplayer room changed (cloud documents). */
  roomState(state: RoomState): void;
  /** The room has its own copy of the document, and nothing typed here yet: reopen from the room. */
  roomReplace(): void;
  /** The document has no room after all (it could not be joined, or was lost while alone in it). */
  roomGone(): void;
  /** Another person's edit changed the document. */
  remoteEdit(): void;
  /** Other people's mouse pointers moved. */
  pointers(pointers: { page: number; x: number; y: number; color: number; name: string; picture: string | null }[]): void;
  error(message: string): void;
  notice(message: string): void;
  shapes(state: { shapes: Shape[]; width: number; height: number; canUndo: boolean; canRedo: boolean }): void;
  vectorScene(state: { scene: Scene | null; canUndo: boolean; canRedo: boolean }): void;
}

/** The page's side of the layout worker. One document is open at a time. */
export class LayoutClient {
  private readonly worker = new Worker(new URL('./layoutWorkerEntry.ts', import.meta.url), { type: 'module', name: 'layout' });
  private doc = 0;
  private listener: DocumentListener | null = null;
  private nextRequest = 1;
  private readonly requests = new Map<number, (bytes: ArrayBuffer | null, error?: string) => void>();
  private readonly linkRequests = new Map<number, (found: { url: string | null; checkbox: boolean }) => void>();
  private readonly spellRequests = new Map<number, (answer: { marks: TextMark[][]; issue: SpellIssue | null; loading: boolean }) => void>();
  private readonly agentRequests = new Map<number, (result: string | { text: string; images: string[] }) => void>();

  /** Finds the stored document an embed (`![[Note]]`) names, as its name and bytes (set by the page, which knows what is stored). */
  embeds: ((title: string) => Promise<{ name: string; bytes: ArrayBuffer } | null>) | null = null;

  constructor(
    /** New faces, before any page that uses them. Called for every document, stale or not. */
    private readonly onFaces: (faces: FaceDescriptor[]) => void,
  ) {
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    this.worker.onerror = (event) => this.listener?.error(event.message || t('app.workerFailed'));
  }

  /**
   * Tells the worker the page's language, so the errors and default names it makes are in it.
   * Call once the language is loaded, before opening any document.
   */
  setLocale(locale: string): void {
    this.send({ type: 'locale', locale });
  }

  /** Opens a document, cancelling any layout in progress; in a collaboration room if given. */
  /** Lets go of the open document with nothing to replace it: messages of the old one are ignored from now on. */
  close(): void {
    this.doc++;
    this.listener = null;
    this.send({ type: 'close' });
  }

  open(source: DocumentSource, listener: DocumentListener, room?: RoomOptions, keepRoom?: boolean): void {
    this.doc++;
    this.listener = listener;
    const transfer: Transferable[] = 'bytes' in source ? [source.bytes] : [];
    this.send({ type: 'open', doc: this.doc, source, room, ...(keepRoom && { keepRoom }) }, transfer);
  }

  /** Tells the room where this user's mouse is (null: it left the document). */
  pointer(pointer: Pointer | null): void {
    this.send({ type: 'pointer', doc: this.doc, pointer });
  }

  /** The open document is now in the cloud: join its multiplayer room (it had none when it opened). */
  joinRoom(room: RoomOptions): void {
    this.send({ type: 'joinRoom', doc: this.doc, room });
  }

  /** The page is going away: leave any collaboration room. */
  leave(): void {
    this.send({ type: 'leave' });
  }

  /** Show or hide formatting marks (paragraph marks, spaces, tabs) on the pages. */
  setMarks(on: boolean): void {
    this.send({ type: 'marks', on });
  }

  /** Lay pages out `width` points wide (Flow view), or at the document's own sizes (null). */
  setReflow(width: number | null): void {
    this.send({ type: 'reflow', width });
  }

  command(command: WireCommand): void {
    this.send({ type: 'command', doc: this.doc, command });
  }

  /** Puts a picture in the open document at the caret. */
  insertImage(bytes: Uint8Array, ext: string, width: number, height: number, description?: string): void {
    const copy = bytes.slice().buffer;
    this.send({ type: 'insertImage', doc: this.doc, bytes: copy, ext, width, height, description }, [copy]);
  }

  /** A picture's shapes are now these. */
  setShapes(shapes: Shape[], base?: Shape[]): void {
    this.send({ type: 'shapes', doc: this.doc, shapes, base });
  }

  /** A drawing edited together is now this. */
  setVectorScene(scene: Scene, base?: Scene): void {
    this.send({ type: 'vectorScene', doc: this.doc, scene, base });
  }

  /** Steps back over, or forward again over, the person's own changes to a drawing edited together. */
  stepVector(action: 'undo' | 'redo'): void {
    this.send({ type: 'vectorStep', doc: this.doc, action });
  }

  /** Steps back over, or forward again over, the person's own changes to a picture's shapes. */
  stepShapes(action: 'undo' | 'redo'): void {
    this.send({ type: 'shapesStep', doc: this.doc, action });
  }

  /** Puts a vector drawing (its SVG text and a picture of it) in the open document at the caret, or in place of the one whose SVG is part `replace`. */
  putDrawing(drawing: { svg: string; png: Uint8Array; width: number; height: number; description?: string }, replace?: string): void {
    const png = drawing.png.slice().buffer;
    this.send({ type: 'putDrawing', doc: this.doc, svg: drawing.svg, png, width: drawing.width, height: drawing.height, description: drawing.description, replace }, [png]);
  }

  /** An image part of the open document. */
  media(part: string): Promise<Uint8Array> {
    return this.request((request) => ({ type: 'media', doc: this.doc, request, part })).then((bytes) => new Uint8Array(bytes));
  }

  /** What is under a point on a page: the address of a link (null when there is none), and whether it is a check box that a click changes. */
  linkAt(page: number, x: number, y: number): Promise<{ url: string | null; checkbox: boolean }> {
    const request = this.nextRequest++;
    return new Promise((resolve) => {
      this.linkRequests.set(request, resolve);
      this.send({ type: 'linkAt', doc: this.doc, request, page, x, y });
    });
  }

  /** The whole open document as a .wdoc; `lens` records a different format to edit it as when next opened. */
  save(lens?: Format): Promise<Uint8Array> {
    return this.request((request) => ({ type: 'save', doc: this.doc, request, lens })).then((bytes) => new Uint8Array(bytes));
  }

  /** The open document exported as a file of a format (lossy); the open document doesn't change. */
  convert(to: Format): Promise<Uint8Array> {
    return this.request((request) => ({ type: 'convert', doc: this.doc, request, to })).then((bytes) => new Uint8Array(bytes));
  }

  /** The open picture's own file, without the shapes drawn over it (what a fill finds its region in). */
  pictureBase(): Promise<Uint8Array> {
    return this.request((request) => ({ type: 'pictureBase', doc: this.doc, request })).then((bytes) => new Uint8Array(bytes));
  }

  /** Runs one of the assistant's tools on the open document (see agentTools.ts). Answers with what it did or found, and any pictures it fetched for the model. */
  agent(name: string, args: string): Promise<string | { text: string; images: string[] }> {
    const request = this.nextRequest++;
    return new Promise((resolve) => {
      this.agentRequests.set(request, resolve);
      this.send({ type: 'agent', doc: this.doc, request, name, args });
    });
  }

  /** What is wrong in each of some lines of a plain text file, or (`at`) the problem under an offset of one of them. */
  spellText(texts: string[], sample: string, what: { spelling: boolean; grammar: boolean }, at?: { index: number; offset: number }): Promise<{ marks: TextMark[][]; issue: SpellIssue | null; loading: boolean }> {
    const request = this.nextRequest++;
    return new Promise((resolve) => {
      this.spellRequests.set(request, resolve);
      this.send({ type: 'spellText', request, texts, sample, ...what, ...(at && { at }) });
    });
  }

  private request(message: (request: number) => ToWorker): Promise<ArrayBuffer> {
    const request = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.requests.set(request, (bytes, error) => (bytes ? resolve(bytes) : reject(new Error(error ?? t('app.documentNotOpen')))));
      this.send(message(request));
    });
  }

  private send(message: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private receive(message: FromWorker): void {
    if (message.type === 'embed') {
      const reply = (file: { name: string; bytes: ArrayBuffer } | null): void => this.send({ type: 'embedFile', request: message.request, file }, file ? [file.bytes] : []);
      (this.embeds?.(message.title) ?? Promise.resolve(null)).then(reply, () => reply(null));
      return;
    }
    if (message.type === 'linkAt') {
      this.linkRequests.get(message.request)?.({ url: message.url, checkbox: message.checkbox });
      this.linkRequests.delete(message.request);
      return;
    }
    if (message.type === 'spellText') {
      this.spellRequests.get(message.request)?.(message);
      this.spellRequests.delete(message.request);
      return;
    }
    if (message.type === 'agentResult') {
      this.agentRequests.get(message.request)?.(message.images?.length ? { text: message.result, images: message.images } : message.result);
      this.agentRequests.delete(message.request);
      return;
    }
    if (message.type === 'media' || message.type === 'saved') {
      this.requests.get(message.request)?.(message.bytes, message.type === 'saved' ? message.error : undefined);
      this.requests.delete(message.request);
      return;
    }
    // Faces are registered whatever document they came with: the worker won't send them again.
    if (message.type === 'layout' && message.faces.length) this.onFaces(message.faces);
    if (message.doc !== this.doc || !this.listener) return;
    switch (message.type) {
      case 'opened':
        this.listener.opened(message.name, message.format, message.annotating, message.outdated);
        break;
      case 'layout':
        this.listener.layout(message);
        break;
      case 'done':
        this.listener.done(message.pages, message.timings);
        break;
      case 'selection':
        this.listener.selection(message);
        break;
      case 'roomState':
        this.listener.roomState(message);
        break;
      case 'roomReplace':
        this.listener.roomReplace();
        break;
      case 'roomGone':
        this.listener.roomGone();
        break;
      case 'remoteEdit':
        this.listener.remoteEdit();
        break;
      case 'pointers':
        this.listener.pointers(message.pointers);
        break;
      case 'error':
        this.listener.error(message.message);
        break;
      case 'notice':
        this.listener.notice(message.message);
        break;
      case 'vectorScene':
        this.listener.vectorScene({ scene: message.scene, canUndo: message.canUndo, canRedo: message.canRedo });
        break;
      case 'shapes':
        this.listener.shapes({ shapes: message.shapes, width: message.width, height: message.height, canUndo: message.canUndo, canRedo: message.canRedo });
        break;
    }
  }
}
