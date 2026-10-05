// How a page (or the layout worker) reaches the multiplayer server's room of a cloud document: the WebSocket for the room, and the
// document the room is editing when someone joins it. Every kind of document joins through this, so the paths live in one place.

import type { RoomClientOptions } from './roomClient.ts';

export function cloudRoomTransport(docId: string): Pick<RoomClientOptions, 'connect' | 'fetchDocument'> {
  return {
    connect: () => new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/rooms/${docId}`) as unknown as ReturnType<RoomClientOptions['connect']>,
    fetchDocument: async () => {
      const response = await fetch(`/api/rooms/${docId}/document`);
      if (!response.ok) throw new Error(`could not fetch the room's document (${response.status})`);
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        epoch: Number(response.headers.get('x-room-epoch')),
        version: Number(response.headers.get('x-room-version')),
      };
    },
  };
}
