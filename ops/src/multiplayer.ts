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
// What a document's changes are depends on what it is: for most they are operations on its text (`doc`); for a PDF, which is lists
// of annotations, fields and edits, they are changes to single objects (`objects`, see ./objects.ts). The first to join says which,
// and the room validates and writes out what it is sent accordingly.
//
// Back to solo: when only one person is left the room sends `settle`; once that client has nothing
// unsent it answers `quiet`, the room writes the final .docx, and sends `solo`.
//
// Each stretch in shared mode is an epoch. Its log starts at version 0 from the .docx in the cloud
// at that moment, so messages carry the epoch and a message from an old one is ignored.
//
// Some kinds of document are not edited by several people at once (ROOM_POLICY 'watch'): their room
// never goes shared. One session holds the document (`holder`): it edits and saves it as if alone.
// Everyone else watches: their copy is read-only, and is opened again each time the holder saves
// (`saved`, which the server sends once a save is in). A watcher may `takeOver`: the room asks the
// holder to save what it has (`release`), and once it answers `released` (or doesn't, in time) the
// watcher holds the document. When the holder leaves, the next session that may edit holds it. A
// session of the same account as a holder that has gone (the page was reloaded) holds it at once.
// Another person and another device of the same account are the same: each is a session.

import type { ClientMessage, ServerMessage } from './collab.ts';
import type { Selection } from './history.ts';

export type RoomMode = 'solo' | 'handoff' | 'shared';
export type RoomRole = 'owner' | 'editor' | 'viewer';

/** What the changes sent to a room are: operations on text, or changes to objects (see objects.ts): a PDF's annotations, fields and edits (`objects`), a picture's shapes (`layers`), or a drawing's nodes (`nodes`); or, for a plain text file, changes to its bytes (`text`, see ./textOps.ts). */
export type RoomKind = 'doc' | 'objects' | 'layers' | 'nodes' | 'text';

/**
 * How several sessions in a room edit its document: together (`shared`: their changes are merged), or one at a time while the others
 * watch (`watch`). A kind is edited together only once its changes can all be merged: PDFs (pages are moved and rotated as whole new
 * files) and pictures (their pixels) are not yet, so they are held by one session. Making one shared is a change to this table.
 */
export const ROOM_POLICY: Record<RoomKind, 'shared' | 'watch'> = { doc: 'shared', text: 'shared', nodes: 'shared', objects: 'watch', layers: 'watch' };

/** Who holds a watched room's document (see ROOM_POLICY): their session, name and account. */
export interface Holder {
  client: string;
  name: string;
  /** Their account, so a session can tell its own other devices from other people. */
  user: string;
}

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
  /** Their profile picture (an https URL), set by the server from their account; null for guests. */
  picture: string | null;
  color: number;
  selection: Selection | null;
  /** Not kept by the room across reconnects: it is only ever the latest position. */
  pointer: Pointer | null;
}

export type MultiplayerClientMessage =
  /** First message: who is joining. */
  | { type: 'hello'; client: string; name: string; color: number; /** What the document's changes are (the first to join says so for the room). */ kind?: RoomKind }
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
  | { type: 'quiet'; epoch: number; version: number }
  /** A watcher asks to hold the document (a watched room). */
  | { type: 'takeOver' }
  /** In answer to `release`: what the holder had is saved; someone else may hold it now. */
  | { type: 'released' };

export type MultiplayerServerMessage =
  /** `user`: this session's account. `holder`: who holds a watched room's document (null: nobody, or a room edited together). */
  | { type: 'welcome'; role: RoomRole; client: string; mode: RoomMode; epoch: number; people: Person[]; kind: RoomKind; user?: string; holder?: Holder | null }
  /** Who holds a watched room's document now. */
  | { type: 'holder'; holder: Holder | null }
  /** The document was saved (a watched room): watchers open it again. */
  | { type: 'saved'; updatedAt: number }
  /** To the holder: someone takes over, so save what you have and answer `released`. */
  | { type: 'release' }
  /** To the holder: someone started watching, so save what you have now rather than in a while. */
  | { type: 'flush' }
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
  /** The same session connected again (after a sleep or a network change) before the room heard this connection drop: it is let go. */
  replaced: 4005,
} as const;
