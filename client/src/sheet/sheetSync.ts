// A workbook in the account, in its room (docs/spreadsheets.md, "Storage, rooms"; `cells`, watched in ROOM_POLICY): one
// session holds it and edits and saves it as if alone; everyone else watches, read-only, and opens it again each time it
// is saved, as a PDF's or a picture's room works (layoutWorker.ts watchRoomHost). The room client
// (collab/roomClient.ts) runs on the page here, beside the spreadsheet editor, as a text file's does (textSync.ts).

import { cloudRoomTransport } from '../collab/cloudRoom.ts';
import { RoomClient, type RoomHost } from '../collab/roomClient.ts';
import type { RoomState } from '../layout/protocol.ts';

export interface SheetRoomOptions {
  docId: string;
  client: string;
  name: string;
  color: number;
  /** The workbook as it is now (.xlsx), for the room when someone joins. */
  serialize(): Promise<Uint8Array>;
  changed(state: RoomState): void;
  /** Gives the room the workbook, as it is. */
  upload(bytes: Uint8Array): Promise<void>;
  /** The room can't be reached and this person was alone in it: the workbook is edited and saved as if it had none. */
  lost(): void;
  /** Watching: the holder saved (`updatedAt`, its new version); open it again. */
  saved(updatedAt: number): void;
  /** Holding: someone takes over; save what there is, then `client.released()`. */
  release(): void;
  /** Holding: someone started watching; save what there is now. */
  flush(): void;
}

export interface SheetRoom {
  client: RoomClient;
}

export function sheetRoom(o: SheetRoomOptions): SheetRoom {
  let shown = '';
  const host: RoomHost = {
    serialize: () => o.serialize(),
    // Nothing is ever handed over or merged: one session edits at a time.
    freeze: () => undefined,
    connect: () => undefined,
    disconnect: () => undefined,
    receive: () => undefined,
    sync: () => null,
    resubmit: () => undefined,
    changed(state) {
      const out: RoomState = {
        mode: state.mode,
        role: state.role,
        people: state.people.map((p) => ({ name: p.name, picture: p.picture, color: p.color, me: p.client === state.me })),
        unconfirmed: 0,
        holder: state.holder && { name: state.holder.name, mine: state.holder.mine },
        watching: state.watching,
        catchingUp: state.catchingUp,
      };
      const key = JSON.stringify(out);
      if (key === shown) return;
      shown = key;
      o.changed(out);
    },
    people: () => undefined,
    pointers: () => undefined,
    lost: () => o.lost(),
    saved: (updatedAt) => o.saved(updatedAt),
    release: () => o.release(),
    flush: () => o.flush(),
  };
  const client = new RoomClient({ client: o.client, name: o.name, color: o.color, kind: 'cells', host, ...cloudRoomTransport(o.docId), upload: o.upload });
  return { client };
}
