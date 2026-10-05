// The only way the rest of the server talks to a document's collaboration room. Routes ask these
// questions and give these orders; none of them builds a room request, knows a room's paths, or
// checks whether rooms are configured (a server without them answers as if nobody were editing).
// The room is the single writer of a document's file while several people edit it: `maySave` is
// the one question every route that writes the file asks first.

import type { Env } from './cf.ts';
import type { Role } from './sharing.ts';

const ROOMS_AT_ONCE = 25;

const roomFor = (env: Env, docId: string) => env.ROOMS.get(env.ROOMS.idFromName(docId));

const order = async (env: Env, docId: string, path: string, user?: string): Promise<void> => {
  await roomFor(env, docId).fetch(new Request(`https://room/${path}${user === undefined ? '' : `?user=${encodeURIComponent(user)}`}`));
};

/** Whether a client may write the document's file now (false while the room is saving it for several people editing). */
export async function roomAllowsSave(env: Env, docId: string): Promise<boolean> {
  if (!env.ROOMS) return true;
  const state = (await (await roomFor(env, docId).fetch(new Request('https://room/state'))).json()) as { maySave: boolean };
  return state.maySave;
}

/** Ends the documents' rooms (they were deleted), a few dozen at a time rather than one after another. */
export async function endRooms(env: Env, docIds: string[]): Promise<void> {
  if (!env.ROOMS) return;
  for (let i = 0; i < docIds.length; i += ROOMS_AT_ONCE) {
    await Promise.all(docIds.slice(i, i + ROOMS_AT_ONCE).map((id) => order(env, id, 'end')));
  }
}

/** Disconnects someone from the room (their access was taken away). */
export async function kickFromRoom(env: Env, docId: string, userId: string): Promise<void> {
  if (env.ROOMS) await order(env, docId, 'kick', userId);
}

/** Makes someone in the room reconnect, so a changed role takes effect now rather than when they next join. */
export async function rejoinRoom(env: Env, docId: string, userId: string): Promise<void> {
  if (env.ROOMS) await order(env, docId, 'rejoin', userId);
}

/** What the room is told about a person joining. Set here and nowhere else: whatever the client sent is replaced. */
export function roomHeaders(headers: Headers, userId: string, role: Role, ownerId: string, docId: string, picture: string | null): Headers {
  const out = new Headers(headers);
  out.set('x-user', userId);
  out.set('x-role', role);
  out.set('x-owner', ownerId);
  out.set('x-doc', docId);
  out.delete('x-picture');
  if (picture) out.set('x-picture', picture);
  return out;
}

/** Hands a request to the document's room: its WebSocket, or (`document`) the file it is editing. */
export function joinRoom(env: Env, docId: string, headers: Headers, document: boolean): Promise<Response> {
  return roomFor(env, docId).fetch(new Request(`https://room/${document ? 'document' : 'ws'}`, { headers }));
}
