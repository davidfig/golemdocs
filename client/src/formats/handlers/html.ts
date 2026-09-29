// HTML: the handler loaded when an HTML file is opened or exported to.

import { documentToHtml, htmlToDocument } from '../html.ts';
import { collectImages } from '../images.ts';
import type { FormatHandler } from '../convert.ts';

const handler: FormatHandler = {
  async read(bytes) {
    const { document, extension } = await htmlToDocument(new TextDecoder('utf-8').decode(bytes));
    return { document, extensions: { html: extension } };
  },
  async write(document, extensions) {
    return new TextEncoder().encode(documentToHtml(document, extensions.html, { images: await collectImages(document) }));
  },
};

export default handler;
