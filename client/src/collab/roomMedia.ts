// Where the pictures people add while editing a document together are kept. The room's changes name a picture by the hash of its
// bytes (see @golemdocs/docx sharedMedia.ts); whoever adds one puts the bytes here first, and whoever needs one they don't have
// asks for it by that hash. A cloud room keeps them with the server (`networkMedia`); the development room, in its SharedWorker
// (`PortMedia`).

import type { RoomClientMessage, RoomServerMessage } from './messages.ts';

export interface RoomMedia {
  /** Keeps a picture's bytes under the hash of them, before the change that names it is sent. */
  put(hash: string, bytes: Uint8Array): Promise<void>;
  /** A picture's bytes; null if the room has none under that hash. */
  get(hash: string): Promise<Uint8Array | null>;
}

/** The pictures of a cloud document's room, with the server. */
export function networkMedia(docId: string): RoomMedia {
  const url = (hash: string) => `/api/rooms/${docId}/media/${hash}`;
  return {
    async put(hash, bytes) {
      const response = await fetch(url(hash), { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes as Uint8Array<ArrayBuffer> });
      if (!response.ok) throw new Error(`upload failed (${response.status})`);
    },
    async get(hash) {
      const response = await fetch(url(hash));
      return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
    },
  };
}

/** The pictures of a development room, with its SharedWorker over `send`; `receive` is given what it answers. */
export class PortMedia implements RoomMedia {
  private next = 1;
  private readonly waiting = new Map<number, (bytes: ArrayBuffer | null) => void>();

  constructor(private readonly send: (message: RoomClientMessage, transfer?: Transferable[]) => void) {}

  put(hash: string, bytes: Uint8Array): Promise<void> {
    const copy = bytes.slice().buffer;
    return new Promise((resolve) => {
      const request = this.next++;
      this.waiting.set(request, () => resolve());
      this.send({ type: 'mediaPut', request, hash, bytes: copy }, [copy]);
    });
  }

  get(hash: string): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const request = this.next++;
      this.waiting.set(request, (bytes) => resolve(bytes ? new Uint8Array(bytes) : null));
      this.send({ type: 'mediaGet', request, hash });
    });
  }

  /** Whether the message was the answer to a picture's put or get (and was handled). */
  receive(message: RoomServerMessage): boolean {
    if (message.type !== 'mediaStored' && message.type !== 'mediaFile') return false;
    const done = this.waiting.get(message.request);
    this.waiting.delete(message.request);
    done?.(message.type === 'mediaFile' ? message.bytes : null);
    return true;
  }
}
