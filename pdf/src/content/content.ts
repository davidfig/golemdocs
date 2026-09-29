// Content streams (§7.8.2, §8.9.7): parsing into operations and writing them back.

import { PdfDict, PdfName, type PdfObject } from '../core/objects.ts';
import { Keyword, Parser, isRegular, isWhitespace } from '../core/parser.ts';
import { ByteWriter, writeObject } from '../core/serialize.ts';

export interface Operation {
  /** The operator, e.g. 'Tj', 're', 'cm'. Inline images are a single 'BI' operation. */
  op: string;
  operands: PdfObject[];
  /** Inline images: the image dictionary is operands[0] and this is the data between ID and EI. */
  data?: Uint8Array;
}

/** Parses a content stream. Damaged content ends the list rather than throwing. */
export function parseContent(bytes: Uint8Array): Operation[] {
  const p = new Parser(bytes, 0, { noRefs: true });
  const ops: Operation[] = [];
  let operands: PdfObject[] = [];
  for (;;) {
    let t;
    try {
      t = p.readToken();
      if (t === undefined) break;
      if (t instanceof Keyword) {
        if (t.value === 'BI') {
          ops.push(readInlineImage(p));
        } else {
          ops.push({ op: t.value, operands });
        }
        operands = [];
        continue;
      }
      operands.push(p.complete(t));
    } catch {
      break;
    }
  }
  return ops;
}

function readInlineImage(p: Parser): Operation {
  const dict = new PdfDict();
  for (;;) {
    const t = p.readToken();
    if (t === undefined) return { op: 'BI', operands: [dict], data: new Uint8Array(0) };
    if (t instanceof Keyword && t.value === 'ID') break;
    const value = p.parseObject();
    if (t instanceof PdfName) dict.set(t.name, value);
  }
  const b = p.bytes;
  // A single whitespace byte separates ID from the data.
  let start = p.pos;
  if (isWhitespace(b[start])) start++;
  const length = dict.get('L') ?? dict.get('Length');
  let end = -1;
  if (typeof length === 'number' && start + length <= b.length) {
    let q = start + length;
    while (q < b.length && isWhitespace(b[q])) q++;
    if (b[q] === 0x45 && b[q + 1] === 0x49 && (q + 2 >= b.length || !isRegular(b[q + 2]))) {
      end = start + length;
      p.pos = q + 2;
    }
  }
  if (end < 0) {
    // Find "EI" delimited by whitespace, followed by what looks like content (binary data can contain "EI").
    for (let q = start; q + 1 < b.length; q++) {
      if (b[q] !== 0x45 || b[q + 1] !== 0x49) continue;
      if (q > start && !isWhitespace(b[q - 1])) continue;
      if (q + 2 < b.length && !isWhitespace(b[q + 2])) continue;
      if (!looksLikeContent(b, q + 2)) continue;
      end = q > start && isWhitespace(b[q - 1]) ? q - 1 : q;
      p.pos = q + 2;
      break;
    }
    if (end < 0) {
      end = b.length;
      p.pos = b.length;
    }
  }
  return { op: 'BI', operands: [dict], data: b.subarray(start, end) };
}

function looksLikeContent(b: Uint8Array, from: number): boolean {
  const end = Math.min(b.length, from + 32);
  for (let i = from; i < end; i++) {
    const c = b[i];
    if (c > 0x7e || (c < 0x20 && !isWhitespace(c))) return false;
  }
  return true;
}

/** Serializes operations as a content stream. */
export function serializeContent(ops: Iterable<Operation>): Uint8Array {
  const w = new ByteWriter();
  for (const o of ops) {
    if (o.op === 'BI') {
      w.text('BI');
      const d = o.operands[0];
      if (d instanceof PdfDict) {
        for (const [k, v] of d) {
          w.text(` /${k} `);
          writeObject(w, v);
        }
      }
      w.text(' ID ');
      if (o.data) w.bytes(o.data);
      w.text('\nEI\n');
      continue;
    }
    for (const operand of o.operands) {
      writeObject(w, operand);
      w.byte(0x20);
    }
    w.text(o.op);
    w.byte(0x0a);
  }
  return w.data.slice();
}
