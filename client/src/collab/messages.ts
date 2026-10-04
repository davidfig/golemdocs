// Messages between a document (in the layout worker) and a collaboration room. The document
// part is @golemdocs/ops's ClientMessage / ServerMessage; around it: joining (the starting
// snapshot and the log so far) and presence (where other people's carets are), which isn't
// part of the document and isn't logged.

import type { ClientMessage, Selection, ServerMessage, Transaction } from '@golemdocs/ops';

export type RoomClientMessage =
  /** Join a room; `snapshot` becomes the room's document if the room is new. */
  | { type: 'join'; room: string; client: string; snapshot: ArrayBuffer; /** Only one person at a time can edit the document: the first to join says so for the room. */ exclusive?: boolean; kind?: 'doc' | 'objects' | 'layers' | 'nodes' }
  | ClientMessage
  | { type: 'presence'; name: string; color: number; selection: Selection | null }
  /** A picture added while editing together, kept under the hash of its bytes; and a request for one. */
  /** Asks to be the one who edits an exclusive room, and lets go of that. */
  | { type: 'lease' }
  | { type: 'release' }
  | { type: 'mediaPut'; request: number; hash: string; bytes: ArrayBuffer }
  | { type: 'mediaGet'; request: number; hash: string }
  | { type: 'leave' };

export type RoomServerMessage =
  | { type: 'joined'; snapshot: ArrayBuffer; transactions: Transaction[]; people: number; exclusive: boolean; holder: string | null }
  /** Who holds an exclusive room's lease now (null: nobody). */
  | { type: 'lease'; holder: string | null }
  | ServerMessage
  | { type: 'presence'; client: string; name: string; color: number; selection: Selection | null }
  | { type: 'people'; count: number }
  | { type: 'mediaStored'; request: number }
  | { type: 'mediaFile'; request: number; bytes: ArrayBuffer | null };
