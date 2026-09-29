// Plain text: the handler loaded when a text file is opened or exported to. Also what data,
// configuration, log and source files open as (see textFiles.ts).

import { documentToText, textToDocument } from '../plainText.ts';
import { decodeText, encodeText } from '../textFiles.ts';
import type { FormatHandler } from '../convert.ts';

const handler: FormatHandler = {
  async read(bytes) {
    const { text, encoding, bom } = decodeText(bytes);
    const ending = /\r\n|\r|\n/.exec(text)?.[0];
    const txt = { ...(bom && encoding === 'utf-8' && { bom }), ...(encoding !== 'utf-8' && { encoding }), ...(ending && ending !== '\n' && { lineEnding: ending as '\r\n' | '\r' }) };
    return { document: await textToDocument(text), extensions: Object.keys(txt).length ? { txt } : {} };
  },
  async write(document, extensions) {
    let text = documentToText(document);
    const { lineEnding, bom, encoding } = extensions.txt ?? {};
    if (lineEnding) text = text.replace(/\n/g, lineEnding);
    return encodeText(text, encoding ?? 'utf-8', !!bom);
  },
};

export default handler;
