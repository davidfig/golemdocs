// Where a document's file and thumbnail are kept in R2, and the file's type. Every key is made
// here: the quick read in documents.ts finds a document's file from its owner and id alone, without the
// catalogue's row, so the format must be the same everywhere.

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The document's .docx. */
export const docxKey = (ownerId: string, docId: string): string => `${ownerId}/${docId}.docx`;

/** The picture of its first page. */
export const thumbKey = (ownerId: string, docId: string): string => `${ownerId}/${docId}.thumb`;

/** Its full-text search index (see docIndex.ts). */
export const indexKey = (ownerId: string, docId: string): string => `${ownerId}/${docId}.idx`;

/** A picture people editing a document together added, kept by the hash of its bytes (see room.ts, roomMedia.ts). */
export const mediaKey = (ownerId: string, docId: string, hash: string): string => `${ownerId}/${docId}.media/${hash}`;

/** One chunk of a document kept as chunks, named by the SHA-256 of its bytes (see fileStore.ts). Chunks belong to one document: nothing is shared across documents or people. */
export const chunkKey = (ownerId: string, docId: string, hash: string): string => `${ownerId}/${docId}.chunks/${hash}`;

/** What every one of a document's chunks' keys starts with. */
export const chunkPrefix = (ownerId: string, docId: string): string => `${ownerId}/${docId}.chunks/`;

/** What every one of a document's pictures' keys starts with. */
export const mediaPrefix = (ownerId: string, docId: string): string => `${ownerId}/${docId}.media/`;

/** A checkpoint of a document: its file as it was before the save that replaced it, named by that file's `updated_at` (see versions.ts). */
export const historyKey = (ownerId: string, docId: string, version: number): string => `${ownerId}/${docId}.history/${version}`;

/** What every one of a document's checkpoints' keys starts with. */
export const historyPrefix = (ownerId: string, docId: string): string => `${ownerId}/${docId}.history/`;
