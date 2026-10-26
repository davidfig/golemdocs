// A three-way merge of a stored document (a .wdoc, or a bare .docx), for an upload that found the cloud copy changed elsewhere (see
// ../library.ts): `base` is the version this copy and the cloud last agreed on, `mine` this copy, `theirs` the cloud's. The document in
// it is merged by `mergeDocuments` (@golemdocs/ops), which only merges changes to different paragraphs; every other entry (what the
// document is edited as, front matter, a format's extension) is taken whole from whichever side changed it, and is a conflict if both
// did. Pictures, drawings and PDFs are not merged. Null whenever it can't be done with confidence: the caller keeps the two apart.

import { WordDocument, ZipArchive, writeZip } from '@golemdocs/docx';
import { mergeDocuments } from '@golemdocs/ops';
import { isWdoc } from './wdoc.ts';

/** Formats whose document isn't flowing text: one person edits them at a time, or they are drawn, so there is nothing to merge. */
const UNMERGED_LENSES = new Set(['pdf', 'png', 'jpeg', 'webp', 'svg', 'svgz']);
const DOCUMENT = 'document.docx';

const same = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean => a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));

/** A stored file's entries by name (a bare .docx is one entry, its document); null for anything else. */
async function entriesOf(bytes: Uint8Array): Promise<{ wdoc: boolean; entries: Map<string, Uint8Array> } | null> {
  let zip: ZipArchive;
  try {
    zip = ZipArchive.read(bytes);
  } catch {
    return null;
  }
  if (!isWdoc(bytes)) return zip.entries.has('word/document.xml') ? { wdoc: false, entries: new Map([[DOCUMENT, bytes]]) } : null;
  const entries = new Map<string, Uint8Array>();
  for (const [name, entry] of zip.entries) entries.set(name, await entry.read());
  return { wdoc: true, entries };
}

/** The merged file, or null. */
export async function mergeStored(baseBytes: Uint8Array, mineBytes: Uint8Array, theirsBytes: Uint8Array): Promise<Uint8Array | null> {
  const [base, mine, theirs] = await Promise.all([entriesOf(baseBytes), entriesOf(mineBytes), entriesOf(theirsBytes)]);
  if (!base || !mine || !theirs) return null;
  // A bare .docx is a .wdoc with only its document (one uploaded as it is, or written by another app): it says nothing about the rest,
  // so a bare side counts as leaving the other entries as they were.
  for (const side of [mine, theirs]) {
    if (side.wdoc) continue;
    for (const [name, data] of base.entries) if (name !== DOCUMENT) side.entries.set(name, data);
  }
  const merged = new Map<string, Uint8Array>();
  for (const name of new Set([...base.entries.keys(), ...mine.entries.keys(), ...theirs.entries.keys()])) {
    const b = base.entries.get(name);
    const m = mine.entries.get(name);
    const t = theirs.entries.get(name);
    let take: Uint8Array | undefined;
    if (same(m, t) || same(t, b)) take = m;
    else if (same(m, b)) take = t;
    else if (name === DOCUMENT && b && m && t) {
      try {
        const document = mergeDocuments(await WordDocument.read(b), await WordDocument.read(m), await WordDocument.read(t));
        if (!document) return null;
        take = await document.write();
      } catch {
        return null;
      }
    } else return null; // changed on both sides, and not something that can be merged
    if (take) merged.set(name, take);
  }
  if (!mine.wdoc && !theirs.wdoc) return merged.get(DOCUMENT) ?? null;
  if (!merged.has('mimetype') || !merged.has('manifest.json')) return null;
  const manifest = merged.get('manifest.json');
  const lens = manifest ? (JSON.parse(new TextDecoder().decode(manifest)) as { lens?: string }).lens : undefined;
  if (!merged.has(DOCUMENT) || (lens !== undefined && UNMERGED_LENSES.has(lens))) return null;
  // `mimetype` first and stored, so the file is still recognised by its first bytes; the document is already compressed.
  const names = ['mimetype', ...[...merged.keys()].filter((name) => name !== 'mimetype')];
  return writeZip(names.filter((name) => merged.has(name)).map((name) => ({ name, data: merged.get(name)!, compress: name.endsWith('.json') })));
}
