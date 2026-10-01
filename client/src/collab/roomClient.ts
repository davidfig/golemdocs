// The client's side of a multiplayer room (the protocol, and who processes edits when, is
// described in @golemdocs/ops multiplayer.ts). It knows nothing about documents or layout: what it
// needs from the open document is the RoomHost below, so it can be tested with a fake socket.
//
// Solo, the document is saved to the cloud as usual and this only reports who else is here. When a
// second person arrives the room asks us to upload the document (`handoff`) and from then on
// edits travel as transactions; when we're alone again the room hands saving back.

import {
  ROOM_CLOSE,
  type ClientMessage,
  type MultiplayerClientMessage,
  type MultiplayerServerMessage,
  type Person,
  type Pointer,
  type RoomRole,
  type Selection,
  type ServerMessage,
} from '@golemdocs/ops';

export interface SocketLike {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
}

/** What the room needs from the open document. */
export interface RoomHost {
  /** The document as .docx bytes. */
  serialize(): Promise<Uint8Array>;
  /** Editing commands wait until this settles (the document is being handed over). */
  freeze(until: Promise<unknown>): void;
  /** Sends the document's edits to the room from now on; `version` is where the document is. */
  connect(send: (message: ClientMessage) => void, version: number): void;
  disconnect(): void;
  /** Applies transactions from the room. */
  receive(message: ServerMessage): void;
  /** Local edits the room hasn't confirmed, and the version the document is at (null: not connected). */
  sync(): { version: number; unconfirmed: number } | null;
  resubmit(): void;
  /** The room, who is in it, or what may be done changed. */
  changed(state: RoomState): void;
  /** People's carets moved (or people came or went). */
  people(people: Person[]): void;
  /** Someone's mouse pointer moved. */
  pointers(people: Person[]): void;
}

export type RoomState = {
  /** solo: saving to the cloud ourselves. shared: the room saves. offline: connection lost for good. */
  mode: 'solo' | 'shared' | 'offline';
  role: RoomRole;
  /** Everyone in the room, including us. */
  people: { client: string; name: string; color: number }[];
};

export type RoomStart =
  /** Open the document as it is (from the cloud or this browser). */
  | { kind: 'own' }
  /** Open this document instead: the room's, at `version` of epoch `epoch`. */
  | { kind: 'room'; bytes: Uint8Array; epoch: number; version: number };

export interface RoomClientOptions {
  client: string;
  name: string;
  color: number;
  host: RoomHost;
  connect(): SocketLike;
  /** The room's current document (`GET /api/rooms/:id/document`). */
  fetchDocument(): Promise<{ bytes: Uint8Array; epoch: number; version: number }>;
  /** Uploads the document to the cloud (PUT). */
  upload(bytes: Uint8Array): Promise<void>;
  timing?: { joinMs: number; handoffMs: number; reconnectMs: number[] };
}

const DEFAULT_TIMING = { joinMs: 20_000, handoffMs: 12_000, reconnectMs: [500, 1000, 2000, 4000, 8000] };

export class RoomClient {
  private socket: SocketLike | null = null;
  private readonly timing;
  private role: RoomRole = 'viewer';
  private people: Person[] = [];
  private mode: RoomState['mode'] = 'solo';
  private epoch = 0;
  /** Whether the host is sending transactions to the room. */
  private attached = false;
  private settling = false;
  private closedByUs = false;
  private attempts = 0;
  /** The document isn't open yet: what arrives now waits. */
  private opened = false;
  private backlog: MultiplayerServerMessage[] = [];
  private welcome: ((m: Extract<MultiplayerServerMessage, { type: 'welcome' }>) => void) | null = null;
  private whenShared: { resolve: (v: 'shared' | 'solo') => void } | null = null;
  private handoff: Promise<void> | null = null;

  constructor(private readonly o: RoomClientOptions) {
    this.timing = o.timing ?? DEFAULT_TIMING;
  }

  get state(): RoomState {
    return { mode: this.mode, role: this.role, people: this.people.map(({ client, name, color }) => ({ client, name, color })) };
  }

  get canEdit(): boolean {
    return this.role !== 'viewer' && this.mode !== 'offline';
  }

  // --- Joining -------------------------------------------------------------------------

  /** Connects, and works out where the document to open comes from. Rejects if there is no room to join. */
  async join(): Promise<RoomStart> {
    const welcome = await this.open();
    this.role = welcome.role;
    this.epoch = welcome.epoch;
    this.people = welcome.people;
    // Alone and saving: open our own copy. Otherwise the room has the current document.
    if (welcome.mode === 'solo' && welcome.people.length <= 1) return { kind: 'own' };
    if (welcome.mode !== 'shared') {
      const outcome = await this.waitForShared();
      if (outcome === 'solo') return { kind: 'own' };
    }
    const doc = await this.o.fetchDocument();
    this.epoch = doc.epoch;
    this.mode = 'shared';
    return { kind: 'room', bytes: doc.bytes, epoch: doc.epoch, version: doc.version };
  }

  private open(): Promise<Extract<MultiplayerServerMessage, { type: 'welcome' }>> {
    return new Promise((resolve, reject) => {
      const socket = this.o.connect();
      this.socket = socket;
      const answered = (m: Extract<MultiplayerServerMessage, { type: 'welcome' }>): void => {
        clearTimeout(timer);
        resolve(m);
      };
      const timer = setTimeout(() => {
        if (this.welcome === answered) this.welcome = null;
        if (this.socket === socket) this.socket = null;
        reject(new Error('the room did not answer'));
        socket.close();
      }, this.timing.joinMs);
      this.welcome = answered;
      socket.onopen = () => this.send({ type: 'hello', client: this.o.client, name: this.o.name, color: this.o.color });
      // A socket given up on (it timed out, or we left) can still deliver or close late, even after
      // its replacement opened: only the current one speaks for the room.
      socket.onmessage = (event) => {
        if (this.socket === socket) this.onMessage(JSON.parse(String(event.data)) as MultiplayerServerMessage);
      };
      socket.onclose = (event) => {
        clearTimeout(timer);
        if (this.welcome === answered) {
          this.welcome = null;
          reject(new Error(`could not join the room (${event.code})`));
        } else if (this.socket === socket) this.onClose(event.code);
      };
    });
  }

  private waitForShared(): Promise<'shared' | 'solo'> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the room did not finish handing over the document')), this.timing.joinMs);
      this.whenShared = {
        resolve: (v) => {
          clearTimeout(timer);
          this.whenShared = null;
          resolve(v);
        },
      };
    });
  }

  /** The document is open (from `join`'s answer): start sending, and process what arrived meanwhile. */
  ready(start: RoomStart): void {
    this.opened = true;
    if (start.kind === 'room') {
      this.attach(start.version);
      this.send({ type: 'sync', epoch: start.epoch, version: start.version });
    }
    const backlog = this.backlog;
    this.backlog = [];
    for (const message of backlog) this.handle(message);
    this.announce();
  }

  private attach(version: number): void {
    this.attached = true;
    this.mode = 'shared';
    this.o.host.connect((message) => this.send({ ...message, epoch: this.epoch }), version);
  }

  // --- Messages ------------------------------------------------------------------------

  private send(message: MultiplayerClientMessage): void {
    try {
      this.socket?.send(JSON.stringify(message));
    } catch {
      // The socket is closing; its close event starts a reconnect.
    }
  }

  private onMessage(message: MultiplayerServerMessage): void {
    if (message.type === 'welcome' && this.welcome) {
      const resolve = this.welcome;
      this.welcome = null;
      return resolve(message);
    }
    if (message.type === 'welcome') return; // only the first answers a hello
    // Deciding where the document comes from comes first; the rest waits for the document.
    if (this.whenShared && (message.type === 'shared' || message.type === 'solo')) return this.whenShared.resolve(message.type);
    if (!this.opened) {
      if (message.type === 'people') this.people = message.people;
      else this.backlog.push(message);
      return;
    }
    this.handle(message);
  }

  private handle(message: MultiplayerServerMessage): void {
    const host = this.o.host;
    switch (message.type) {
      case 'people':
        this.people = message.people;
        host.people(this.people);
        this.announce();
        break;
      case 'presence': {
        const person = this.people.find((p) => p.client === message.client);
        if (person) person.selection = message.selection;
        host.people(this.people);
        break;
      }
      case 'pointer': {
        const person = this.people.find((p) => p.client === message.client);
        if (person) person.pointer = message.pointer;
        host.pointers(this.people);
        break;
      }
      case 'handoff':
        this.epoch = message.epoch;
        this.startHandoff();
        break;
      case 'shared':
        this.epoch = message.epoch;
        if (this.handoff || !this.attached) this.attachAfterHandoff();
        break;
      case 'transactions':
        if (message.epoch !== this.epoch || !this.attached) break;
        host.receive(message);
        if (this.reconnected) {
          this.reconnected = false;
          host.resubmit();
        }
        this.checkQuiet();
        break;
      case 'settle':
        this.settling = true;
        this.checkQuiet();
        break;
      case 'solo':
        this.epoch = message.epoch;
        this.settling = false;
        if (this.attached) host.disconnect();
        this.attached = false;
        this.mode = 'solo';
        this.announce();
        break;
    }
  }

  /** We are alone or someone new is here, and must give the room our document before anyone else can edit. */
  private startHandoff(): void {
    if (this.handoff || this.attached) return;
    const done = (async () => {
      const bytes = await this.o.host.serialize();
      await this.o.upload(bytes);
      this.send({ type: 'flushed', epoch: this.epoch });
      // Nothing may be edited until the room says it now takes edits (`shared`), or gives up.
      await new Promise<void>((resolve) => {
        this.sharedHook = resolve;
        setTimeout(resolve, this.timing.handoffMs);
      });
    })().catch((error) => console.error('handoff failed', error));
    this.handoff = done;
    this.o.host.freeze(done);
    void done.then(() => (this.handoff = null));
  }

  private sharedHook: (() => void) | null = null;

  /** `shared` arrived: our document is the room's starting point (version 0). */
  private attachAfterHandoff(): void {
    if (!this.attached) {
      this.attach(0);
      this.send({ type: 'sync', epoch: this.epoch, version: 0 });
    }
    this.sharedHook?.();
    this.sharedHook = null;
    this.announce();
  }

  /** When the room is winding down and everything we sent has been confirmed, say so. */
  private checkQuiet(): void {
    if (!this.settling || !this.attached) return;
    const sync = this.o.host.sync();
    if (sync && sync.unconfirmed === 0) this.send({ type: 'quiet', epoch: this.epoch, version: sync.version });
  }

  presence(selection: Selection | null): void {
    if (this.attached || this.mode === 'solo') this.send({ type: 'presence', selection });
  }

  pointer(pointer: Pointer | null): void {
    if (this.attached || this.mode === 'solo') this.send({ type: 'pointer', pointer });
  }

  private announce(): void {
    this.o.host.changed(this.state);
  }

  // --- Losing the connection -----------------------------------------------------------

  private reconnected = false;

  private onClose(code: number): void {
    this.socket = null;
    if (this.closedByUs) return;
    // Refused for good: our view is stale, or we were let go.
    const final = code === ROOM_CLOSE.revoked || code === ROOM_CLOSE.badMessage;
    if (final || this.attempts >= this.timing.reconnectMs.length) return this.giveUp();
    const delay = this.timing.reconnectMs[this.attempts++]!;
    setTimeout(() => void this.reconnect(), delay);
  }

  private async reconnect(): Promise<void> {
    if (this.closedByUs) return;
    try {
      const wasAttached = this.attached;
      const epoch = this.epoch;
      const welcome = await this.open();
      this.attempts = 0;
      this.role = welcome.role;
      this.people = welcome.people;
      // What we have is only good to continue with if the room is where we left it.
      if (wasAttached ? welcome.mode === 'shared' && welcome.epoch === epoch : welcome.mode === 'solo' && welcome.people.length <= 1) {
        if (wasAttached) {
          this.reconnected = true;
          this.send({ type: 'sync', epoch, version: this.o.host.sync()!.version });
        }
        this.announce();
      } else this.giveUp();
    } catch {
      this.onClose(0);
    }
  }

  /** The room can't be rejoined: keep what is on screen, but stop editing it. */
  private giveUp(): void {
    if (this.attached) this.o.host.disconnect();
    this.attached = false;
    this.mode = 'offline';
    this.announce();
  }

  leave(): void {
    this.closedByUs = true;
    this.socket?.close(1000);
    this.socket = null;
  }
}
