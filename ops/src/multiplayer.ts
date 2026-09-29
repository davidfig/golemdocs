// The wire protocol between a document and the multiplayer server's room (one room per cloud
// document), over a WebSocket, one JSON message per frame. The document part is ClientMessage /
// ServerMessage from ./collab.ts; around it: who is here, carets, and who processes edits.
//
// Who processes edits depends on how many people have the document open:
//
//   solo     One person. They save the .docx to the cloud themselves, as usual; the room only
//            tells them who else arrives. (`welcome` with mode 'solo'.)
//   handoff  A second person arrived. The room asks the first to upload their document (`handoff`),
//            and they answer `flushed`. Nobody edits through the room until then.
//   shared   Everyone sends transactions (`submit`); the room orders them, broadcasts them, and
//            writes the resulting .docx to the cloud. Clients no longer upload files.
//
// Back to solo: when only one person is left the room sends `settle`; once that client has nothing
// unsent it answers `quiet`, the room writes the final .docx, and sends `solo`.
//
// Each stretch in shared mode is an epoch. Its log starts at version 0 from the .docx in the cloud
// at that moment, so messages carry the epoch and a message from an old one is ignored.

import type { ClientMessage, ServerMessage } from './collab.ts';
import type { Selection } from './history.ts';

export type RoomMode = 'solo' | 'handoff' | 'shared';
export type RoomRole = 'owner' | 'editor' | 'viewer';

/** Where someone's mouse pointer is: on this page (its position in display order), at this point on it (points). */
export interface Pointer {
  page: number;
  x: number;
  y: number;
}

export interface Person {
  /** Identifies this connection (one user can have several tabs). */
  client: string;
  name: string;
  color: number;
  selection: Selection | null;
  /** Not kept by the room across reconnects: it is only ever the latest position. */
  pointer: Pointer | null;
}

export type MultiplayerClientMessage =
  /** First message: who is joining. */
  | { type: 'hello'; client: string; name: string; color: number }
  /** In answer to `handoff`: the document is uploaded; later edits will be submitted from version 0. */
  | { type: 'flushed'; epoch: number }
  /**
   * In shared mode: "my document is at `version`" (the .docx from `GET /api/rooms/:id/document`
   * says which, or 0 for the client that flushed). The room answers with the transactions after it.
   */
  | { type: 'sync'; epoch: number; version: number }
  | (ClientMessage & { epoch: number })
  | { type: 'presence'; selection: Selection | null }
  /** Where the mouse is (null: it left the document). Sent often, so it is relayed and never stored. */
  | { type: 'pointer'; pointer: Pointer | null }
  /** In answer to `settle`: nothing unsent, at this version. */
  | { type: 'quiet'; epoch: number; version: number };

export type MultiplayerServerMessage =
  | { type: 'welcome'; role: RoomRole; client: string; mode: RoomMode; epoch: number; people: Person[] }
  | { type: 'handoff'; epoch: number }
  | { type: 'shared'; epoch: number }
  | (ServerMessage & { epoch: number })
  | { type: 'settle'; epoch: number }
  | { type: 'solo'; epoch: number }
  | { type: 'people'; people: Person[] }
  | { type: 'presence'; client: string; selection: Selection | null }
  | { type: 'pointer'; client: string; pointer: Pointer | null };

/** Close codes the room uses. */
export const ROOM_CLOSE = {
  /** The client's view of the room is out of date: reconnect and start again. */
  stale: 4002,
  /** The room asked for a document upload and didn't get one. */
  handoffFailed: 4001,
  /** Access to the document was withdrawn, or the document was deleted. */
  revoked: 4003,
  /** Not a message the room understands. */
  badMessage: 4004,
} as const;
