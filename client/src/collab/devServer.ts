// A collaboration server for development, in a SharedWorker: every tab of this origin that
// joins a room talks to the same one. It runs the reference CollabServer from @golemdocs/ops, so it
// exercises exactly the protocol a networked server will speak (see ./messages.ts); only the
// transport (MessagePorts instead of sockets) and persistence (none) differ.

import { CollabServer } from '@golemdocs/ops';
import type { RoomClientMessage, RoomServerMessage } from './messages.ts';

interface Room {
  /** The document every client starts from (.docx bytes). */
  snapshot: ArrayBuffer;
  server: CollabServer;
  /** Latest presence per client (not part of the document). */
  presence: Map<string, Extract<RoomServerMessage, { type: 'presence' }>>;
  ports: Set<MessagePort>;
  /** The clients in the room. */
  members: Set<string>;
  /** Pictures people added, by the hash of their bytes. */
  media: Map<string, ArrayBuffer>;
  /** Only one person at a time may edit (a drawing): the one who holds the lease, and when they last did something. */
  exclusive: boolean;
  holder: string | null;
  holderAt: number;
}

/** How long the holder of the lease may do nothing before someone else can take it. */
const LEASE_MS = 30_000;

const rooms = new Map<string, Room>();

/** The lease goes to someone (or nobody), and everyone in the room is told. */
function setHolder(room: Room, holder: string | null): void {
  room.holder = holder;
  room.holderAt = Date.now();
  for (const port of room.ports) port.postMessage({ type: 'lease', holder } satisfies RoomServerMessage);
}

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
          room = { snapshot: message.snapshot, server: new CollabServer(), presence: new Map(), ports: new Set(), members: new Set(), media: new Map(), exclusive: message.exclusive === true, holder: null, holderAt: 0 };
          rooms.set(message.room, room);
        }
        client = message.client;
        room.ports.add(port);
        room.members.add(client);
        connection = room.server.connect((m) => post(m));
        const snapshot = room.snapshot.slice(0);
        // The first to join an exclusive room may edit: nobody else is there to. Later, whoever asks first.
        if (room.exclusive && room.holder === null && room.members.size === 1) [room.holder, room.holderAt] = [client, Date.now()];
        post({ type: 'joined', snapshot, transactions: connection.welcome.transactions, people: room.ports.size, exclusive: room.exclusive, holder: room.holder }, [snapshot]);
        for (const presence of room.presence.values()) post(presence);
        others({ type: 'people', count: room.ports.size });
        break;
      }
      case 'submit':
        // An exclusive room takes edits from the one who holds its lease only.
        if (room?.exclusive && room.holder !== client) post({ type: 'lease', holder: room.holder });
        else {
          if (room) room.holderAt = Date.now();
          connection?.submit(message);
        }
        break;
      case 'lease': {
        if (!room?.exclusive) break;
        const here = room.holder !== null && room.members.has(room.holder);
        const idle = Date.now() - room.holderAt > LEASE_MS;
        if (room.holder === null || room.holder === client || !here || idle) {
          if (room.holder === client) room.holderAt = Date.now();
          else setHolder(room, client);
        } else post({ type: 'lease', holder: room.holder });
        break;
      }
      case 'release':
        if (room?.exclusive && room.holder === client) setHolder(room, null);
        break;
      case 'presence': {
        if (!room) break;
        const presence: RoomServerMessage = { type: 'presence', client, name: message.name, color: message.color, selection: message.selection };
        room.presence.set(client, presence);
        others(presence);
        break;
      }
      case 'mediaPut':
        room?.media.set(message.hash, message.bytes);
        post({ type: 'mediaStored', request: message.request });
        break;
      case 'mediaGet': {
        const bytes = room?.media.get(message.hash)?.slice(0) ?? null;
        post({ type: 'mediaFile', request: message.request, bytes }, bytes ? [bytes] : []);
        break;
      }
      case 'leave':
        if (!room) break;
        connection?.disconnect();
        room.ports.delete(port);
        room.presence.delete(client);
        room.members.delete(client);
        if (room.exclusive && room.holder === client) setHolder(room, null);
        others({ type: 'presence', client, name: '', color: 0, selection: null });
        others({ type: 'people', count: room.ports.size });
        room = null;
        break;
    }
  };
  port.start();
}

(self as unknown as { onconnect: (event: MessageEvent) => void }).onconnect = (event) => connect(event.ports[0]);
