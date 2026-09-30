// File ▸ Download All: every saved document, zipped. Only ever `import()`ed (it pulls in the ZIP writer).
import { writeZip } from '@word/docx';

export interface ArchiveDoc {
  name: string;
  bytes: ArrayBuffer | Uint8Array;
}

/** The names to store the documents under: as saved, with " (2)", " (3)"… before the extension where two would collide. */
export function archiveNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let unique = name;
    for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${base} (${n})${ext}`;
    taken.add(unique.toLowerCase());
    return unique;
  });
}

/** A ZIP holding each document as a file. Formats that are already compressed are stored as they are. */
export function zipDocuments(docs: readonly ArchiveDoc[]): Promise<Uint8Array> {
  const names = archiveNames(docs.map((d) => d.name));
  return writeZip(
    docs.map((d, i) => ({
      name: names[i],
      data: d.bytes instanceof Uint8Array ? d.bytes : new Uint8Array(d.bytes),
      compress: !/\.(docx|wdoc|epub|pdf|png|jpe?g|gif|webp|zip|xlsx|pptx|odt)$/i.test(names[i]),
    })),
  );
}
