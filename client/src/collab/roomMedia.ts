// Where the pictures people add while editing a document together are kept. The room's changes name a picture by the hash of its
// bytes (see @golemdocs/docx sharedMedia.ts); whoever adds one puts the bytes here first, and whoever needs one they don't have
// asks for it by that hash. A cloud room keeps them with the server (`networkMedia`).

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
