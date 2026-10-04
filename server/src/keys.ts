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

/** What every one of a document's pictures' keys starts with. */
export const mediaPrefix = (ownerId: string, docId: string): string => `${ownerId}/${docId}.media/`;
