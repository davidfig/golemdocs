// Plain text: the handler loaded when a text file is opened or exported to.

import { documentToText, textToDocument } from '../plainText.ts';
import type { FormatHandler } from '../convert.ts';

const encoder = new TextEncoder();

const handler: FormatHandler = {
  async read(bytes) {
    const text = new TextDecoder('utf-8').decode(bytes);
    // The decoder drops a UTF-8 byte order mark, so look at the bytes.
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const ending = /\r\n|\r|\n/.exec(text)?.[0];
    const txt = { ...(bom && { bom }), ...(ending && ending !== '\n' && { lineEnding: ending as '\r\n' | '\r' }) };
    return { document: await textToDocument(text), extensions: Object.keys(txt).length ? { txt } : {} };
  },
  async write(document, extensions) {
    let text = documentToText(document);
    if (extensions.txt) {
      const { lineEnding, bom } = extensions.txt;
      if (lineEnding) text = text.replace(/\n/g, lineEnding);
      if (bom) text = `﻿${text}`;
    }
    return encoder.encode(text);
  },
};

export default handler;
