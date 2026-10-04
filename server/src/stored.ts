// What a document's file in R2 holds. The app saves its own .wdoc (a ZIP with the document as
// `document.docx` inside, see client/src/formats/wdoc.ts) under the document's key, and what the
// server reads of a document (its search index, its search by meaning) needs the .docx in it.

import { ZipArchive, writeZip } from '@golemdocs/docx';

/** The first entry of a .wdoc, and what it holds. */
const WDOC_MIME = 'application/x-golem-document';

/**
 * The .docx in a stored file: the one inside a .wdoc, or the bytes themselves when it is a plain .docx
 * (or anything else, for the reader to refuse). Null for a .wdoc with no flowing document in it (a PDF
 * that hasn't been turned into one): it has no text for the server to read.
 */
export async function storedDocx(bytes: Uint8Array): Promise<Uint8Array | null> {
  let zip: ZipArchive;
  try {
    zip = ZipArchive.read(bytes);
  } catch {
    return bytes;
  }
  const mime = zip.entries.get('mimetype');
  if (!mime || (await mime.text()) !== WDOC_MIME) return bytes;
  const document = zip.entries.get('document.docx');
  return document ? document.read() : null;
}

/**
 * A stored file with its document replaced by `docx`. A .wdoc keeps everything else it has (the format the document is
 * edited as, its extensions) exactly as it was; a plain .docx (or anything that isn't a .wdoc) is just replaced.
 */
export async function replaceStoredDocx(stored: Uint8Array, docx: Uint8Array): Promise<Uint8Array> {
  let zip: ZipArchive;
  try {
    zip = ZipArchive.read(stored);
  } catch {
    return docx;
  }
  const mime = zip.entries.get('mimetype');
  if (!mime || (await mime.text()) !== WDOC_MIME) return docx;
  // The document is already compressed (a .docx is a ZIP), so it is stored.
  return writeZip([...zip.entries.values()].map((entry) => (entry.name === 'document.docx' ? { name: entry.name, data: docx, compress: false } : { name: entry.name, entry })));
}
