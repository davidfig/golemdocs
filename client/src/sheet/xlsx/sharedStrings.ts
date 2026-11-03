// Reads xl/sharedStrings.xml as it inflates into the workbook's string pool: string i of the file becomes id i. Each `<si>`
// is plain text (`<t>`) or rich text (runs `<r><rPr/><t/></r>`); the text is the runs' `<t>`s joined, and phonetic hints
// (`<rPh>`) are left out. Run formatting is not kept yet (M1, see docs/spreadsheets.md "Formatting").

import type { StringPool } from '../model/strings.ts';

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const SI_END = new TextEncoder().encode('</si>');
const RPH_END = new TextEncoder().encode('</rPh>');

export class SharedStringsScanner {
  private carry: Uint8Array | null = null;
  private pieces: number[] = [];

  constructor(private readonly strings: StringPool) {}

  push(piece: Uint8Array): void {
    let buf = piece;
    if (this.carry) {
      buf = new Uint8Array(this.carry.length + piece.length);
      buf.set(this.carry);
      buf.set(piece, this.carry.length);
      this.carry = null;
    }
    const at = this.scan(buf);
    if (at < buf.length) this.carry = buf.slice(at);
  }

  private scan(buf: Uint8Array): number {
    let at = 0;
    for (;;) {
      const lt = buf.indexOf(LT, at);
      if (lt < 0) return buf.length;
      if (lt + 3 >= buf.length) return lt;
      if (buf[lt + 1] !== 0x73 /* s */ || buf[lt + 2] !== 0x69 /* i */ || (buf[lt + 3] !== GT && buf[lt + 3] !== 0x20)) {
        at = lt + 1;
        continue;
      }
      const gt = buf.indexOf(GT, lt);
      if (gt < 0) return lt;
      if (buf[gt - 1] === SLASH) {
        this.strings.addEscaped(buf, gt, gt);
        at = gt + 1;
        continue;
      }
      const end = indexOf(buf, SI_END, gt + 1);
      if (end < 0) return lt;
      this.item(buf, gt + 1, end);
      at = end + SI_END.length;
    }
  }

  /** One string's XML, between `<si>` and `</si>`. */
  private item(buf: Uint8Array, at: number, end: number): void {
    const pieces = this.pieces;
    pieces.length = 0;
    for (;;) {
      const lt = buf.indexOf(LT, at);
      if (lt < 0 || lt >= end) break;
      const c1 = buf[lt + 1];
      const gt = buf.indexOf(GT, lt);
      if (c1 === 0x74 /* t */ && (buf[lt + 2] === GT || buf[lt + 2] === 0x20)) {
        if (buf[gt - 1] === SLASH) {
          at = gt + 1;
          continue;
        }
        const stop = buf.indexOf(LT, gt + 1);
        pieces.push(gt + 1, stop);
        at = stop;
      } else if (c1 === 0x72 /* r */ && buf[lt + 2] === 0x50 /* P */ && buf[lt + 3] === 0x68 /* h */) {
        const close = indexOf(buf, RPH_END, gt + 1);
        at = close < 0 || close > end ? end : close + RPH_END.length;
      } else {
        at = gt + 1;
      }
    }
    if (pieces.length === 2) this.strings.addEscaped(buf, pieces[0], pieces[1]);
    else if (pieces.length === 0) this.strings.addEscaped(buf, at, at);
    else this.strings.addEscapedPieces(buf, pieces);
  }
}

function indexOf(buf: Uint8Array, needle: Uint8Array, at: number): number {
  for (;;) {
    const i = buf.indexOf(needle[0], at);
    if (i < 0 || i + needle.length > buf.length) return -1;
    let j = 1;
    while (j < needle.length && buf[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
    at = i + 1;
  }
}
