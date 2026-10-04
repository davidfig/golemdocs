// Writing the edited text of a big file back the way it was read: UTF-8 (with its byte order mark if it had one) or UTF-16.
// A Windows-1252 file is written as UTF-8, which keeps every character; the editor says so when it opens one.

import type { TextEncoding } from '../formats/textFiles.ts';
import { PieceTable } from './pieceTable.ts';

/** The text as bytes in `encoding`. */
export function encodeTable(table: PieceTable, encoding: TextEncoding, bom: boolean): Uint8Array {
  if (encoding === 'utf-16le' || encoding === 'utf-16be') return encodeUtf16(table, encoding === 'utf-16le');
  const text = table.flatten();
  if (!bom) return text;
  const out = new Uint8Array(text.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(text, 3);
  return out;
}

/** UTF-16 with a byte order mark, made a piece at a time (a character split between two pieces is carried over). */
function encodeUtf16(table: PieceTable, little: boolean): Uint8Array {
  // A UTF-16 text never has more units than the UTF-8 it came from has bytes.
  const out = new Uint8Array(2 + table.length * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xfeff, little);
  const decoder = new TextDecoder('utf-8');
  let at = 2;
  const put = (text: string): void => {
    for (let i = 0; i < text.length; i++, at += 2) view.setUint16(at, text.charCodeAt(i), little);
  };
  for (const chunk of table.chunks(1 << 20)) put(decoder.decode(chunk, { stream: true }));
  put(decoder.decode());
  return out.slice(0, at);
}
