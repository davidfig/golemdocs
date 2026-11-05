// A document kept in the app's own file (.wdoc) while edited as CSV or TSV, as every CSV and TSV was before they opened in the
// grid: its table written out as the file it stands for (with the delimiter, line endings and encoding it kept), so it opens
// in the grid and is saved as that file from then on.
//
// A CSV or TSV file with a layout (column widths and the like, which such a file cannot hold) is kept in the same container: the
// file whole (`Wdoc.delimited`) and its layout in `extensions.csv`. One with no layout stays the plain file, as anything else reads it.

import { WordDocument } from '@golemdocs/docx';
import { documentToRows, writeDelimited } from './csv.ts';
import { isWdoc, readWdoc, type SheetLayout } from './wdoc.ts';

/** The CSV or TSV file a .wdoc edited as one stands for; null when it is edited as something else (or can't be read). */
export async function delimitedFromWdoc(bytes: Uint8Array): Promise<{ kind: 'csv' | 'tsv'; bytes: Uint8Array; layout?: SheetLayout } | null> {
  if (!isWdoc(bytes)) return null;
  try {
    const wdoc = await readWdoc(bytes);
    const kind = wdoc.manifest.lens;
    if (kind !== 'csv' && kind !== 'tsv') return null;
    if (wdoc.delimited) return { kind, bytes: wdoc.delimited, layout: wdoc.extensions.csv?.layout };
    if (!wdoc.document) return null;
    const rows = documentToRows(await WordDocument.read(wdoc.document));
    const ext = wdoc.extensions.csv ?? {};
    return { kind, bytes: writeDelimited(rows, kind === 'tsv' ? '\t' : (ext.delimiter ?? ','), ext) };
  } catch {
    return null;
  }
}
