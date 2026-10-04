// A plain text file edited together with others (see @golemdocs/ops textOps.ts): the page's side of the room. The room client
// (collab/roomClient.ts, which does not depend on where it runs) asks this host for the file's bytes when someone arrives, hands
// it others' changes, and tells it who is here. What the person changes is sent by the text document itself (textDocument.ts).

import { TextReplica, type ClientMessage, type ServerMessage } from '@golemdocs/ops';
import { RoomClient, type RoomHost, type RoomState as ClientRoomState, type SocketLike } from '../collab/roomClient.ts';
import type { RoomState } from '../layout/protocol.ts';
import type { TextEditorView } from './view.ts';

export interface TextRoomOptions {
  /** The cloud document. */
  docId: string;
  /** This browser's id in the room, how the person is called, and their colour. */
  client: string;
  name: string;
  color: number;
  /** The editor the file is open in (null: it was closed). */
  view(): TextEditorView | null;
  /** The room, who is in it, or the changes not yet confirmed changed. */
  changed(state: RoomState): void;
  /** Others' changes were put into the file (it is kept in this browser too). */
  remoteEdit(): void;
  /** Gives the room the file, as it is, when someone else arrives. */
  upload(bytes: Uint8Array): Promise<void>;
}

export interface TextRoom {
  client: RoomClient;
  /** Tells the page again how the room stands if what it shows (changes not confirmed) changed. */
  refresh(): void;
}

export function textRoom(o: TextRoomOptions): TextRoom {
  let replica: TextReplica | null = null;
  let last: ClientRoomState | null = null;
  let shown = '';
  const emit = (): void => {
    if (!last) return;
    const state: RoomState = {
      mode: last.mode,
      role: last.role,
      people: last.people.map((p) => ({ name: p.name, picture: p.picture, color: p.color, me: p.client === last!.me })),
      unconfirmed: replica?.unconfirmed ?? 0,
    };
    const key = JSON.stringify(state);
    if (key === shown) return;
    shown = key;
    o.changed(state);
  };
  const host: RoomHost = {
    serialize: async () => o.view()?.flatten() ?? new Uint8Array(0),
    freeze(until: Promise<unknown>) {
      const view = o.view();
      if (!view) return;
      view.frozen = true;
      void until.finally(() => (view.frozen = false));
    },
    connect(send: (message: ClientMessage) => void, version: number) {
      const view = o.view();
      if (!view) return;
      watch();
      const mine = new TextReplica(send, version, (ops) => {
        view.applyRemote(ops);
        o.remoteEdit();
      });
      replica = mine;
      view.share(mine, o.client);
    },
    disconnect() {
      replica = null;
      o.view()?.unshare();
      emit();
    },
    receive(message: ServerMessage) {
      replica?.receive(message);
      emit();
    },
    sync: () => (replica ? { version: replica.version, unconfirmed: replica.unconfirmed } : null),
    resubmit: () => replica?.resubmit(),
    changed(state) {
      last = state;
      emit();
    },
    people(people) {
      const view = o.view();
      // Selections are byte offsets of the text (the room's selection type is for documents, where the paragraph is named: here it is left empty).
      view?.setPeople(people.map((p) => ({ client: p.client, color: p.color, selection: p.selection ? { anchor: p.selection.anchor.offset, focus: p.selection.focus.offset } : null })), o.client);
    },
    pointers: () => undefined,
  };
  // Where this person's caret is, sent a moment after it stops moving.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let announced: ReturnType<typeof o.view> = null;
  const watch = (): void => {
    const view = o.view();
    if (!view || view === announced) return;
    announced = view;
    view.onPresence = (anchor, focus) => {
      clearTimeout(timer);
      timer = setTimeout(() => client.presence({ anchor: { paragraph: '', offset: anchor }, focus: { paragraph: '', offset: focus } }), 120);
    };
  };
  const client = new RoomClient({
    client: o.client,
    name: o.name,
    color: o.color,
    kind: 'text',
    host,
    connect: () => new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/rooms/${o.docId}`) as unknown as SocketLike,
    fetchDocument: async () => {
      const response = await fetch(`/api/rooms/${o.docId}/document`);
      if (!response.ok) throw new Error(`could not fetch the room's document (${response.status})`);
      return { bytes: new Uint8Array(await response.arrayBuffer()), epoch: Number(response.headers.get('x-room-epoch')), version: Number(response.headers.get('x-room-version')) };
    },
    upload: o.upload,
  });
  return { client, refresh: emit };
}
