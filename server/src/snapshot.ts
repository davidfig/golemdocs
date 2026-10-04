// Turns a document and the transactions logged since it into the new file (a .docx, or the .wdoc the document is stored in, with the format it is edited as and its extensions kept). The room does this
// while two or more people are editing: their clients stop uploading files and the server, which
// holds the one ordered log, is the only writer. Application is deterministic (see @golemdocs/ops), so
// the result is exactly what every client shows.

import { applyObjectOps, Engine, layersOf, objectOps, type ObjectLayers, type RoomKind, type Transaction } from '@golemdocs/ops';
import { SHARED_MEDIA_IN_TEXT, sharedMediaHash, WordDocument, writeZip, ZipArchive } from '@golemdocs/docx';
import { replaceStoredDocx, storedDocx } from './stored.ts';

/** The bytes of a picture people added while editing together, by the hash of its bytes (null: it was never uploaded). */
export type MediaLookup = (hash: string) => Promise<Uint8Array | null>;

/** `base` (a .docx, or a .wdoc holding one) with `transactions` applied in order, and the pictures they refer to put into it. */
export async function applyLog(base: Uint8Array, transactions: readonly Transaction[], media?: MediaLookup, kind: RoomKind = 'doc'): Promise<Uint8Array> {
  const apply = kind === 'doc' ? (b: Uint8Array, txs: readonly Transaction[]) => applyAll(b, txs, media) : (b: Uint8Array, txs: readonly Transaction[]) => applyObjects(b, txs, kind);
  try {
    return await apply(base, transactions);
  } catch {
    // A transaction that can't be applied, or leaves a document that can't be written (malformed,
    // from a broken or hostile client), would stop every snapshot from now on, and the room from
    // ever ending. So they are applied one at a time instead, and any that fails is left out.
    let bytes = base;
    for (const tx of transactions) bytes = await apply(bytes, [tx]).catch(() => bytes);
    return bytes;
  }
}

async function applyAll(base: Uint8Array, transactions: readonly Transaction[], media?: MediaLookup): Promise<Uint8Array> {
  const docx = await storedDocx(base);
  if (!docx) throw new Error('the stored document has no text to edit');
  const doc = await WordDocument.read(docx);
  const engine = new Engine(doc);
  for (const tx of transactions) engine.apply(tx.ops);
  // A picture one of them added is a part the document doesn't have yet: its bytes were uploaded by the person who added it.
  if (media) {
    const named = new Set<string>(JSON.stringify(transactions.map((tx) => tx.ops)).match(SHARED_MEDIA_IN_TEXT) ?? []);
    for (const part of named) {
      const hash = sharedMediaHash(part);
      if (!hash || doc.hasPart(part)) continue;
      const bytes = await media(hash);
      if (bytes) doc.setMedia(part, bytes);
    }
  }
  return replaceStoredDocx(base, await doc.write());
}

/** The entry of a .wdoc that holds the lists of objects of a document, and which lists (see client/src/formats/wdoc.ts): a PDF's annotations, form fields and edits; a picture's shapes. */
const OBJECT_ENTRIES = {
  objects: { entry: 'extensions/pdf.json', layers: ['annotations', 'fields', 'edits'] },
  layers: { entry: 'extensions/img.json', layers: ['shapes'] },
  nodes: { entry: 'extensions/vec.json', layers: ['meta', 'nodes', 'defs'] },
} as const;

/**
 * `base` (a .wdoc) with changes to the objects of its lists applied. Only the one entry that holds the lists is written again: the
 * PDF or picture itself, and everything else, are copied as they are.
 */
async function applyObjects(base: Uint8Array, transactions: readonly Transaction[], kind: Exclude<RoomKind, 'doc'>): Promise<Uint8Array> {
  const { entry: entryName, layers: names } = OBJECT_ENTRIES[kind];
  const zip = ZipArchive.read(base);
  const entry = zip.entries.get(entryName);
  const extension = (entry ? JSON.parse(await entry.text()) : {}) as Record<string, { id: string }[] | undefined>;
  const touched = new Set<string>();
  let layers: ObjectLayers = layersOf(Object.fromEntries(names.map((name) => [name, extension[name] ?? []])));
  for (const tx of transactions) {
    const ops = objectOps(tx).filter((op) => (names as readonly string[]).includes(op.layer));
    for (const op of ops) touched.add(op.layer);
    layers = applyObjectOps(layers, ops).layers;
  }
  // A list the file never had stays missing unless a change put something in it (for a PDF a missing list means "as in the file").
  const written: Record<string, unknown> = { ...extension };
  for (const layer of names) if (extension[layer] !== undefined || touched.has(layer)) written[layer] = layers[layer];
  const data = new TextEncoder().encode(JSON.stringify(written, null, 2));
  const inputs = [...zip.entries.values()].map((e) => (e.name === entryName ? { name: e.name, data } : { name: e.name, entry: e }));
  if (!entry) inputs.push({ name: entryName, data });
  return writeZip(inputs);
}
