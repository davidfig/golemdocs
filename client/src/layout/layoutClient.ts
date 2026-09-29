import type { FaceDescriptor } from '@word/layout';
import type { Format } from '../formats/convert.ts';
import type { DocumentSource, FromWorker, LayoutTimings, LayoutUpdate, RoomOptions, SelectionUpdate, ToWorker, WireCommand } from './protocol.ts';

/** Callbacks for one document. None fire after another document is opened. */
export interface DocumentListener {
  /** `format`: what the document is edited as; `annotating`: a PDF's own pages, which take markup annotations. */
  opened(name: string, format: Format, annotating: boolean): void;
  layout(update: LayoutUpdate): void;
  /** The first full layout finished. */
  done(pages: number, timings: LayoutTimings): void;
  selection(update: SelectionUpdate): void;
  /** Collaboration status (documents opened in a room). */
  room(people: number, version: number, unconfirmed: number): void;
  error(message: string): void;
}

/** The page's side of the layout worker. One document is open at a time. */
export class LayoutClient {
  private readonly worker = new Worker(new URL('./layoutWorker.ts', import.meta.url), { type: 'module', name: 'layout' });
  private doc = 0;
  private listener: DocumentListener | null = null;
  private nextRequest = 1;
  private readonly requests = new Map<number, (bytes: ArrayBuffer | null, error?: string) => void>();

  constructor(
    /** New faces, before any page that uses them. Called for every document, stale or not. */
    private readonly onFaces: (faces: FaceDescriptor[]) => void,
  ) {
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    this.worker.onerror = (event) => this.listener?.error(event.message || 'layout worker failed to start');
  }

  /** Opens a document, cancelling any layout in progress; in a collaboration room if given. */
  open(source: DocumentSource, listener: DocumentListener, room?: RoomOptions): void {
    this.doc++;
    this.listener = listener;
    const transfer: Transferable[] = 'bytes' in source ? [source.bytes] : [];
    if (room) transfer.push(room.port);
    this.send({ type: 'open', doc: this.doc, source, room }, transfer);
  }

  /** The page is going away: leave any collaboration room. */
  leave(): void {
    this.send({ type: 'leave' });
  }

  command(command: WireCommand): void {
    this.send({ type: 'command', doc: this.doc, command });
  }

  /** An image part of the open document. */
  media(part: string): Promise<Uint8Array> {
    return this.request((request) => ({ type: 'media', doc: this.doc, request, part })).then((bytes) => new Uint8Array(bytes));
  }

  /** The whole open document as a .wdoc; `lens` records a different format to edit it as when next opened. */
  save(lens?: Format): Promise<Uint8Array> {
    return this.request((request) => ({ type: 'save', doc: this.doc, request, lens })).then((bytes) => new Uint8Array(bytes));
  }

  /** The open document exported as a file of a format (lossy); the open document doesn't change. */
  convert(to: Format): Promise<Uint8Array> {
    return this.request((request) => ({ type: 'convert', doc: this.doc, request, to })).then((bytes) => new Uint8Array(bytes));
  }

  private request(message: (request: number) => ToWorker): Promise<ArrayBuffer> {
    const request = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.requests.set(request, (bytes, error) => (bytes ? resolve(bytes) : reject(new Error(error ?? 'unavailable'))));
      this.send(message(request));
    });
  }

  private send(message: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private receive(message: FromWorker): void {
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
        this.listener.opened(message.name, message.format, message.annotating);
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
      case 'error':
        this.listener.error(message.message);
        break;
    }
  }
}
