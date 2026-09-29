// Rich Text Format: the handler loaded when an .rtf file is opened or exported to.

import { documentToRtf } from '../rtfExport.ts';
import { rtfToDocument } from '../rtfImport.ts';
import type { FormatHandler } from '../convert.ts';

const handler: FormatHandler = {
  async read(bytes) {
    return { document: await rtfToDocument(bytes), extensions: {} };
  },
  write: (document) => documentToRtf(document),
};

export default handler;
