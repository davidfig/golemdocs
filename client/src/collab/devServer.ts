// A collaboration server for development, in a SharedWorker: every tab of this origin that
// joins a room talks to the same one. It runs the reference CollabServer from @word/ops, so it
// exercises exactly the protocol a networked server will speak (see ./messages.ts); only the
// transport (MessagePorts instead of sockets) and persistence (none) differ.

import { CollabServer } from '@word/ops';
import type { RoomClientMessage, RoomServerMessage } from './messages.ts';

interface Room {
  /** The document every client starts from (.docx bytes). */
  snapshot: ArrayBuffer;
  server: CollabServer;
  /** Latest presence per client (not part of the document). */
  presence: Map<string, Extract<RoomServerMessage, { type: 'presence' }>>;
  ports: Set<MessagePort>;
}

const rooms = new Map<string, Room>();

function connect(port: MessagePort): void {
  let room: Room | null = null;
  let client = '';
  let connection: ReturnType<CollabServer['connect']> | null = null;
  const post = (message: RoomServerMessage, transfer: Transferable[] = []) => port.postMessage(message, transfer);
  const others = (message: RoomServerMessage) => {
    for (const other of room?.ports ?? []) if (other !== port) other.postMessage(message);
  };

  port.onmessage = (event: MessageEvent<RoomClientMessage>) => {
    const message = event.data;
    switch (message.type) {
      case 'join': {
        room = rooms.get(message.room) ?? null;
        if (!room) {
          room = { snapshot: message.snapshot, server: new CollabServer(), presence: new Map(), ports: new Set() };
          rooms.set(message.room, room);
        }
        client = message.client;
        room.ports.add(port);
        connection = room.server.connect((m) => post(m));
        const snapshot = room.snapshot.slice(0);
        post({ type: 'joined', snapshot, transactions: connection.welcome.transactions, people: room.ports.size }, [snapshot]);
        for (const presence of room.presence.values()) post(presence);
        others({ type: 'people', count: room.ports.size });
        break;
      }
      case 'submit':
        connection?.submit(message);
        break;
      case 'presence': {
        if (!room) break;
        const presence: RoomServerMessage = { type: 'presence', client, name: message.name, color: message.color, selection: message.selection };
        room.presence.set(client, presence);
        others(presence);
        break;
      }
      case 'leave':
        if (!room) break;
        connection?.disconnect();
        room.ports.delete(port);
        room.presence.delete(client);
        others({ type: 'presence', client, name: '', color: 0, selection: null });
        others({ type: 'people', count: room.ports.size });
        room = null;
        break;
    }
  };
  port.start();
}

(self as unknown as { onconnect: (event: MessageEvent) => void }).onconnect = (event) => connect(event.ports[0]);
