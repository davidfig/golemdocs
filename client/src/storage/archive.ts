// File ▸ Download All: every saved document, zipped. Only ever `import()`ed (it pulls in the ZIP writer).
import { writeZip } from '@golemdocs/docx';
import { uniqueName } from './uniqueName.ts';

export interface ArchiveDoc {
  name: string;
  bytes: ArrayBuffer | Uint8Array;
  /** The names of the folders it is in, outermost first; empty at the top level. */
  folders?: readonly string[];
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
      compress: !/\.(docx|wdoc|epub|pdf|png|jpe?g|gif|webp|zip|xlsx|pptx|odt)$/i.test(names[i]),
    })),
  );
}
