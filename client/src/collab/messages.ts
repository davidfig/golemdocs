// Messages between a document (in the layout worker) and a collaboration room. The document
// part is @word/ops's ClientMessage / ServerMessage; around it: joining (the starting
// snapshot and the log so far) and presence (where other people's carets are), which isn't
// part of the document and isn't logged.

import type { ClientMessage, Selection, ServerMessage, Transaction } from '@word/ops';

export type RoomClientMessage =
  /** Join a room; `snapshot` becomes the room's document if the room is new. */
  | { type: 'join'; room: string; client: string; snapshot: ArrayBuffer }
  | ClientMessage
  | { type: 'presence'; name: string; color: number; selection: Selection | null }
  | { type: 'leave' };

export type RoomServerMessage =
  | { type: 'joined'; snapshot: ArrayBuffer; transactions: Transaction[]; people: number }
  | ServerMessage
  | { type: 'presence'; client: string; name: string; color: number; selection: Selection | null }
  | { type: 'people'; count: number };
