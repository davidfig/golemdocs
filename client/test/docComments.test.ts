// Comments read from a Word 97-2003 file (src/formats/docImport.ts). The file is built here, byte
// by byte: a compound file holding a WordDocument stream (FIB and text) and a 0Table stream (the
// piece table and the comment tables).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentMarkerOffsets, commentRanges, paragraphsIn, paragraphText } from '@word/docx';
import { docToDocument } from '../src/formats/docImport.ts';

const FREE = 0xffffffff;
const END = 0xfffffffe;

/** A compound file with 512-byte sectors and these top-level streams (stored as regular streams). */
function compoundFile(streams: [string, Uint8Array][]): Uint8Array {
  const sectors = (n: number) => Math.max(Math.ceil(n / 512), 1);
  const padded = streams.map(([name, data]) => ({ name, data, count: sectors(data.length) }));
  const total = 2 + padded.reduce((a, s) => a + s.count, 0);
  assert.ok(total <= 128, 'one FAT sector is enough');
  const out = new Uint8Array((1 + total) * 512);
  const view = new DataView(out.buffer);
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(24, 0x3e, true);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, 1, true); // one FAT sector: sector 0
  view.setUint32(48, 1, true); // the directory: sector 1
  view.setUint32(56, 0, true); // no mini stream
  view.setUint32(60, END, true);
  view.setUint32(68, END, true);
  for (let i = 0; i < 109; i++) view.setUint32(76 + i * 4, i === 0 ? 0 : FREE, true);
  const fat = (s: number, v: number) => view.setUint32(512 + s * 4, v, true);
  for (let i = 0; i < 128; i++) fat(i, FREE);
  fat(0, 0xfffffffd);
  fat(1, END);
  const dir = (index: number, name: string, type: number, start: number, size: number) => {
    const at = 512 * 2 + index * 128;
    for (let i = 0; i < name.length; i++) view.setUint16(at + i * 2, name.charCodeAt(i), true);
    view.setUint16(at + 64, name.length * 2 + 2, true);
    out[at + 66] = type;
    view.setUint32(at + 116, start, true);
    view.setUint32(at + 120, size, true);
  };
  dir(0, 'Root Entry', 5, END, 0);
  let sector = 2;
  padded.forEach((s, k) => {
    dir(k + 1, s.name, 2, sector, s.data.length);
    for (let i = 0; i < s.count; i++) fat(sector + i, i === s.count - 1 ? END : sector + i + 1);
    out.set(s.data, (1 + sector) * 512);
    sector += s.count;
  });
  return out;
}

class Bytes {
  readonly data = new Uint8Array(4096);
  readonly view = new DataView(this.data.buffer);
  u16(at: number, v: number) {
    this.view.setUint16(at, v, true);
  }
  u32(at: number, v: number) {
    this.view.setUint32(at, v, true);
  }
  utf16(at: number, s: string) {
    for (let i = 0; i < s.length; i++) this.u16(at + i * 2, s.charCodeAt(i));
  }
}

const dttm = (year: number, month: number, day: number, hour: number, minute: number) => minute | (hour << 6) | (day << 11) | (month << 16) | ((year - 1900) << 20);

/**
 * A document with two paragraphs and two comments. Comment 0 (Alice, "AL", 2024-03-15 09:30) marks
 * "brave" through a bookmark; comment 1 (Bob, "BO", no date) has no bookmark, so it is a point in
 * the second paragraph. The second one has two paragraphs of text.
 */
function build(): Uint8Array {
  const main = 'Hello brave\x05 world.\rSecond\x05 para.\r';
  const notes = ['\x05Nice word\r', '\x05Second\rline two\r'];
  const annotation = notes.join('');
  const text = main + annotation;
  const ref0 = main.indexOf('\x05');
  const ref1 = main.lastIndexOf('\x05');

  const word = new Bytes();
  word.u16(0, 0xa5ec);
  word.u16(2, 0xc1);
  word.u16(10, 0); // 0Table
  word.u16(32, 0); // no FibRgW97
  word.u16(34, 22); // FibRgLw97
  word.u32(36 + 3 * 4, main.length);
  word.u32(36 + 7 * 4, annotation.length);
  const pairs = 116;
  word.u16(36 + 22 * 4, pairs);
  const fcLcb = (i: number, fc: number, lcb: number) => {
    word.u32(36 + 22 * 4 + 2 + i * 8, fc);
    word.u32(36 + 22 * 4 + 2 + i * 8 + 4, lcb);
  };
  const textAt = 2048;
  for (let i = 0; i < text.length; i++) word.data[textAt + i] = text.charCodeAt(i);

  const table = new Bytes();
  let at = 0;
  const place = (index: number, length: number): number => {
    fcLcb(index, at, length);
    const start = at;
    at += length;
    return start;
  };
  // CLX: one piece of 8-bit text.
  const clx = place(33, 1 + 4 + 8 + 8);
  table.data[clx] = 2;
  table.u32(clx + 1, 16);
  table.u32(clx + 5, 0);
  table.u32(clx + 9, text.length);
  table.u32(clx + 13 + 2, (textAt * 2) | 0x40000000);

  // Comments: PlcfandRef (CPs, then ATRDPre10 of 30 bytes), PlcfandTxt, the authors.
  const ref = place(4, 3 * 4 + 2 * 30);
  [ref0, ref1, main.length].forEach((cp, i) => table.u32(ref + i * 4, cp));
  const atrd = (i: number, initials: string, author: number) => {
    const at = ref + 12 + i * 30;
    table.u16(at, initials.length);
    table.utf16(at + 2, initials);
    table.u16(at + 20, author);
  };
  atrd(0, 'AL', 0);
  atrd(1, 'BO', 1);
  const txt = place(5, 4 * 4);
  [0, notes[0].length, annotation.length, annotation.length + 1].forEach((cp, i) => table.u32(txt + i * 4, cp));
  const owners = ['Alice', 'Bob'];
  const grp = place(36, owners.reduce((n, o) => n + 2 + o.length * 2, 0));
  let o = grp;
  for (const name of owners) {
    table.u16(o, name.length);
    table.utf16(o + 2, name);
    o += 2 + name.length * 2;
  }
  // The bookmark for comment 0: from "brave" to its reference mark.
  const bkf = place(42, 8 + 4);
  table.u32(bkf, main.indexOf('brave'));
  table.u32(bkf + 4, main.indexOf('brave') + 5);
  const bkl = place(43, 8);
  table.u32(bkl, ref0);
  table.u32(bkl + 4, ref0 + 1);
  // The dates: PlcfandRefAtrdExtra-style records of 12 bytes, dttm first.
  const extra = place(112, 12 + 2 * 12);
  table.u32(extra + 12, dttm(2024, 3, 15, 9, 30));

  return compoundFile([
    ['WordDocument', word.data],
    ['0Table', table.data],
  ]);
}

test('comments read with text, author, initials and date', async () => {
  const doc = await docToDocument(build());
  assert.deepEqual(doc.comments, [
    { id: '0', author: 'Alice', initials: 'AL', date: '2024-03-15T09:30:00Z', paragraphs: ['Nice word'] },
    { id: '1', author: 'Bob', initials: 'BO', paragraphs: ['Second', 'line two'] },
  ]);
});

test('a comment marks the range it was made on, and one without a range is a point', async () => {
  const doc = await docToDocument(build());
  const paragraphs = paragraphsIn(doc.body);
  const plain = (p: (typeof paragraphs)[number]) => paragraphText(p).replaceAll('\uFFFC', '');
  assert.equal(plain(paragraphs[0]), 'Hello brave world.');
  assert.equal(plain(paragraphs[1]), 'Second para.');
  const ranges = commentRanges(paragraphs);
  const zero = ranges.get('0')!;
  assert.equal(zero.start.paragraph, paragraphs[0]);
  assert.equal(zero.end.paragraph, paragraphs[0]);
  // "brave" is characters 6 to 11; the start marker takes one position, so the range starts at 7.
  assert.equal(zero.start.offset, 7);
  assert.deepEqual(commentMarkerOffsets(paragraphs[0], '0'), [13, 12, 6]);
  const one = ranges.get('1')!;
  assert.equal(one.start.paragraph, paragraphs[1]);
  assert.equal(one.end.paragraph, paragraphs[1]);
  assert.equal(commentMarkerOffsets(paragraphs[1], '1').length, 3);
});
