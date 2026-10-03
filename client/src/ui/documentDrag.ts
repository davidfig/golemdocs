// A stored document dragged from the Files panel or the Documents screen: dropped on an open document it becomes a link to it
// (see `linkDroppedDocument` in main.ts). The drag carries the document's library key under its own type, which only this page
// can read, so a document dragged out to another application is still just its name.

const DOCUMENT_DRAG = 'application/x-golem-document';

/** Marks the drag in `data` as a drag of the document with library key `key`, named `name`. */
export function setDocumentDrag(data: DataTransfer, key: string, name: string): void {
  data.effectAllowed = 'linkMove';
  data.setData('text/plain', name);
  data.setData(DOCUMENT_DRAG, key);
}

/** Whether the drag in `data` is one of documents (the key is only readable when it is dropped). */
export const isDocumentDrag = (data: DataTransfer | null): boolean => !!data?.types.includes(DOCUMENT_DRAG);

/** The library key of the document dropped, or null. */
export const droppedDocumentKey = (data: DataTransfer | null): string | null => data?.getData(DOCUMENT_DRAG) || null;
