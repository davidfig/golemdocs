// Jupyter notebooks: the handler loaded when a .ipynb is opened or exported to. Its Markdown cells go
// through the Markdown reader, so it is a chunk of its own.

import { documentToNotebook, notebookToDocument } from '../ipynb.ts';
import type { FormatHandler } from '../convert.ts';

const handler: FormatHandler = {
  async read(bytes) {
    const { document, extension } = await notebookToDocument(new TextDecoder('utf-8').decode(bytes));
    return { document, extensions: { ipynb: extension } };
  },
  async write(document, extensions) {
    return new TextEncoder().encode(documentToNotebook(document, extensions.ipynb));
  },
};

export default handler;
