// File ▸ Download All: every saved document as the file any other program opens, zipped.
import { writeZip } from '@golemdocs/docx';
import { stem } from '../formats/source.ts';
import { isWdoc, WDOC_EXTENSION } from '../formats/wdoc.ts';
import { uniqueName } from './uniqueName.ts';

export interface ArchiveDoc {
  name: string;
  bytes: ArrayBuffer | Uint8Array;
  /** The names of the folders it is in, outermost first; empty at the top level. */
  folders?: readonly string[];
}

/**
 * The documents as files, as the vault writes them (`toFile` is `VaultCodec.toFile`): what is stored is mostly the app's own
 * container, which no other program opens, whatever its name says. One at a time, because a conversion's time limit starts when it
 * is asked for. A document that can't be converted is never left out: the container goes under a `.wdoc` name that says what it
 * is, and is listed in `kept`; anything else stored is already a file, and goes as it is.
 */
export async function archiveFiles(
  docs: readonly ArchiveDoc[],
  toFile: (stored: Uint8Array, name: string) => Promise<Uint8Array | null>,
): Promise<{ docs: ArchiveDoc[]; kept: string[] }> {
  const files: ArchiveDoc[] = [];
  const kept: string[] = [];
  for (const doc of docs) {
    const stored = doc.bytes instanceof Uint8Array ? doc.bytes : new Uint8Array(doc.bytes);
    const file = await toFile(stored, doc.name).catch(() => null);
    if (file) files.push({ ...doc, bytes: file });
    else if (isWdoc(stored)) {
      files.push({ ...doc, name: stem(doc.name) + WDOC_EXTENSION, bytes: stored });
      kept.push(doc.name);
    } else files.push({ ...doc, bytes: stored });
  }
  return { docs: files, kept };
}

/** A folder or file name that is one path segment: no slashes, and not empty. */
const segment = (name: string): string => name.replace(/[\\/]/g, '_').trim() || '_';

/**
 * The paths to store the documents under: as saved (inside their folders, as "a/b/name"), with
 * " (2)", " (3)"… before the extension where two in the same folder would collide.
 */
export function archiveNames(names: readonly string[], folders: readonly (readonly string[] | undefined)[] = []): string[] {
  const taken = new Set<string>();
  return names.map((name, i) => {
    const dir = (folders[i] ?? []).map(segment).map((s) => s + '/').join('');
    const unique = uniqueName(name, taken, dir);
    return dir + unique;
  });
}

/** A ZIP holding each document as a file, in the folders it is in. Formats that are already compressed are stored as they are. */
export function zipDocuments(docs: readonly ArchiveDoc[]): Promise<Uint8Array> {
  const names = archiveNames(docs.map((d) => d.name), docs.map((d) => d.folders));
  return writeZip(
    docs.map((d, i) => ({
      name: names[i],
      data: d.bytes instanceof Uint8Array ? d.bytes : new Uint8Array(d.bytes),
      compress: !/\.(docx|wdoc|epub|pdf|png|jpe?g|gif|webp|heic|heif|zip|xlsx|pptx|odt)$/i.test(names[i]),
    })),
  );
}
