// CSV and TSV: the handlers for comma-, tab-, semicolon- or pipe-delimited text. A .tsv is always
// tab-delimited; a .csv's delimiter is sniffed and remembered, so it is written back unchanged.

import { decodeText, delimitedToDocument, documentToRows, parseDelimited, sniffDelimiter, writeDelimited } from '../csv.ts';
import type { FormatHandler } from '../convert.ts';
import type { CsvExtension } from '../wdoc.ts';

function handler(tabs: boolean): FormatHandler {
  return {
    async read(bytes) {
      const { text, encoding, bom } = decodeText(bytes);
      const delimiter = tabs ? '\t' : sniffDelimiter(text);
      const { rows, lineEnding, trailingNewline } = parseDelimited(text, delimiter);
      const csv: CsvExtension = {
        ...(!tabs && delimiter !== ',' && { delimiter }),
        ...(lineEnding !== '\n' && { lineEnding }),
        ...(bom && { bom }),
        ...(encoding !== 'utf-8' && { encoding }),
        ...(!trailingNewline && { trailingNewline: false }),
      };
      return { document: await delimitedToDocument(rows), extensions: Object.keys(csv).length ? { csv } : {} };
    },
    async write(document, extensions) {
      const ext = extensions.csv ?? {};
      return writeDelimited(documentToRows(document), tabs ? '\t' : (ext.delimiter ?? ','), ext);
    },
  };
}

export const csv = handler(false);
export const tsv = handler(true);
