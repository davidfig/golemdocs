import type { FaceDescriptor } from '@golemdocs/layout';
import type { Pointer } from '@golemdocs/ops';
import type { Format } from '../formats/convert.ts';
import { t } from '../i18n/index.ts';
import type { DocumentSource, FromWorker, LayoutTimings, LayoutUpdate, RoomOptions, RoomState, SelectionUpdate, ToWorker, WireCommand } from './protocol.ts';

/** Callbacks for one document. None fire after another document is opened. */
export interface DocumentListener {
  /** `format`: what the document is edited as; `annotating`: a PDF's own pages, which take markup annotations. */
  opened(name: string, format: Format, annotating: boolean, outdated: boolean): void;
  layout(update: LayoutUpdate): void;
  /** The first full layout finished. */
  done(pages: number, timings: LayoutTimings): void;
  selection(update: SelectionUpdate): void;
  /** Collaboration status (documents opened in a room). */
  room(people: number, version: number, unconfirmed: number): void;
  /** The multiplayer room changed (cloud documents). */
  roomState(state: RoomState): void;
  /** The room has its own copy of the document, and nothing typed here yet: reopen from the room. */
  roomReplace(): void;
  /** Another person's edit changed the document. */
  remoteEdit(): void;
  /** Other people's mouse pointers moved. */
  pointers(pointers: { page: number; x: number; y: number; color: number; name: string; picture: string | null }[]): void;
  error(message: string): void;
}

/** The page's side of the layout worker. One document is open at a time. */
export class LayoutClient {
  private readonly worker = new Worker(new URL('./layoutWorkerEntry.ts', import.meta.url), { type: 'module', name: 'layout' });
  private doc = 0;
  private listener: DocumentListener | null = null;
  private nextRequest = 1;
  private readonly requests = new Map<number, (bytes: ArrayBuffer | null, error?: string) => void>();
  private readonly linkRequests = new Map<number, (found: { url: string | null; checkbox: boolean }) => void>();
  private readonly agentRequests = new Map<number, (result: string | { text: string; images: string[] }) => void>();

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
  open(source: DocumentSource, listener: DocumentListener, room?: RoomOptions): void {
    this.doc++;
    this.listener = listener;
    const transfer: Transferable[] = 'bytes' in source ? [source.bytes] : [];
    if (room?.kind === 'dev') transfer.push(room.port);
    this.send({ type: 'open', doc: this.doc, source, room }, transfer);
  }

  /** Tells the room where this user's mouse is (null: it left the document). */
  pointer(pointer: Pointer | null): void {
    this.send({ type: 'pointer', doc: this.doc, pointer });
  }

  /** The open document is now in the cloud: join its multiplayer room (it had none when it opened). */
  joinRoom(room: Extract<RoomOptions, { kind: 'network' }>): void {
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

  /** Lay pages out `width` points wide (Normal view), or at the document's own sizes (null). */
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

  /** Runs one of the assistant's tools on the open document (see agentTools.ts). Answers with what it did or found, and any pictures it fetched for the model. */
  agent(name: string, args: string): Promise<string | { text: string; images: string[] }> {
    const request = this.nextRequest++;
    return new Promise((resolve) => {
      this.agentRequests.set(request, resolve);
      this.send({ type: 'agent', doc: this.doc, request, name, args });
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
    if (message.type === 'linkAt') {
      this.linkRequests.get(message.request)?.({ url: message.url, checkbox: message.checkbox });
      this.linkRequests.delete(message.request);
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
      case 'room':
        this.listener.room(message.people, message.version, message.unconfirmed);
        break;
      case 'roomState':
        this.listener.roomState(message);
        break;
      case 'roomReplace':
        this.listener.roomReplace();
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
    }
  }
}
