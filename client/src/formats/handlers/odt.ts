// OpenDocument text: the handler loaded when an .odt file is opened or exported to.

import { readOdt, writeOdt } from '@word/odt';
import type { FormatHandler } from '../convert.ts';

const handler: FormatHandler = {
  async read(bytes) {
    const { document, extension } = await readOdt(bytes);
    return { document, extensions: { odt: extension } };
  },
  write: (document, extensions) => writeOdt(document, extensions.odt),
};

export default handler;
