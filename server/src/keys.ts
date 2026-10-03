// Where a document's file and thumbnail are kept in R2, and the file's type. Every key is made
// here: the quick read in documents.ts finds a document's file from its owner and id alone, without the
// catalogue's row, so the format must be the same everywhere.

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The document's .docx. */
export const docxKey = (ownerId: string, docId: string): string => `${ownerId}/${docId}.docx`;

/** The picture of its first page. */
export const thumbKey = (ownerId: string, docId: string): string => `${ownerId}/${docId}.thumb`;
