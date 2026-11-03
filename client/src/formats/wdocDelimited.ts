// A document kept in the app's own file (.wdoc) while edited as CSV or TSV, as every CSV and TSV was before they opened in the
// grid: its table written out as the file it stands for (with the delimiter, line endings and encoding it kept), so it opens
// in the grid and is saved as that file from then on.

import { WordDocument } from '@golemdocs/docx';
import { documentToRows, writeDelimited } from './csv.ts';
import { isWdoc, readWdoc } from './wdoc.ts';

/** The CSV or TSV file a .wdoc edited as one stands for; null when it is edited as something else (or can't be read). */
export async function delimitedFromWdoc(bytes: Uint8Array): Promise<{ kind: 'csv' | 'tsv'; bytes: Uint8Array } | null> {
  if (!isWdoc(bytes)) return null;
  try {
    const wdoc = await readWdoc(bytes);
    const kind = wdoc.manifest.lens;
    if ((kind !== 'csv' && kind !== 'tsv') || !wdoc.document) return null;
    const rows = documentToRows(await WordDocument.read(wdoc.document));
    const ext = wdoc.extensions.csv ?? {};
    return { kind, bytes: writeDelimited(rows, kind === 'tsv' ? '\t' : (ext.delimiter ?? ','), ext) };
  } catch {
    return null;
  }
}
