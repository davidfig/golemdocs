// Cross-reference data (§7.5.4, §7.5.8): classic tables, cross-reference streams, hybrid
// files and incremental-update chains, plus reconstruction by scanning when the xref is
// missing or damaged.

import { decodeStream } from '../filters/filters.ts';
import { PdfDict, PdfStream, isName, type PdfObject } from './objects.ts';
import { Parser, PdfSyntaxError, ascii, indexOf, isRegular, lastIndexOf, latin1 } from './parser.ts';

export type XrefEntry =
  | { type: 0 }
  | { type: 1; offset: number; gen: number }
  | { type: 2; stream: number; index: number };

export interface XrefData {
  entries: Map<number, XrefEntry>;
  /** The newest trailer, with Root/Info/Encrypt/ID filled from older ones if it lacks them. */
  trailer: PdfDict;
  /** Offset of the newest xref section (the file's startxref value). */
  startxref: number;
  /** The newest section was a cross-reference stream. */
  usesXrefStream: boolean;
}

export class XrefError extends Error {}

/** Finds `startxref <offset>` near the end of the file. */
export function findStartXref(bytes: Uint8Array): number {
  const at = lastIndexOf(bytes, ascii('startxref'), bytes.length - 9);
  if (at < 0) throw new XrefError('no startxref');
  const p = new Parser(bytes, at + 9);
  p.skipSpace();
  const offset = Number(p.readRegular());
  if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.length) throw new XrefError('invalid startxref');
  return offset;
}

/** Reads the chain of xref sections starting at `startxref`, newest first. */
export function readXref(bytes: Uint8Array, startxref: number, headerOffset: number): XrefData {
  const entries = new Map<number, XrefEntry>();
  const seen = new Set<number>();
  let trailer: PdfDict | undefined;
  let usesXrefStream = false;
  const pending: number[] = [startxref];

  while (pending.length) {
    let offset = pending.shift()!;
    if (seen.has(offset)) continue;
    seen.add(offset);
    // Files with junk before the header have every offset shifted by the junk's length.
    if (!looksLikeXref(bytes, offset) && headerOffset && looksLikeXref(bytes, offset + headerOffset)) offset += headerOffset;

    const section = readSection(bytes, offset, entries);
    if (!trailer) {
      trailer = section.trailer.clone();
      usesXrefStream = section.isStream;
    } else {
      for (const key of ['Root', 'Info', 'Encrypt', 'ID']) {
        if (!trailer.has(key) && section.trailer.has(key)) trailer.set(key, section.trailer.get(key));
      }
    }
    // A hybrid file's /XRefStm is read before /Prev: its entries take precedence.
    const stm = section.trailer.get('XRefStm');
    if (typeof stm === 'number') {
      try {
        readSection(bytes, stm, entries);
      } catch {
        // a damaged hidden stream in a hybrid file: the table still covers most readers
      }
    }
    const prev = section.trailer.get('Prev');
    if (typeof prev === 'number') pending.push(prev);
  }
  if (!trailer) throw new XrefError('no trailer');
  return { entries, trailer, startxref, usesXrefStream };
}

function looksLikeXref(bytes: Uint8Array, offset: number): boolean {
  const p = new Parser(bytes, offset);
  p.skipSpace();
  const word = p.readRegular();
  if (word === 'xref') return true;
  if (!/^\d+$/.test(word)) return false;
  p.skipSpace();
  if (!/^\d+$/.test(p.readRegular())) return false;
  p.skipSpace();
  return p.readRegular() === 'obj';
}

function readSection(bytes: Uint8Array, offset: number, entries: Map<number, XrefEntry>): { trailer: PdfDict; isStream: boolean } {
  const p = new Parser(bytes, offset);
  p.skipSpace();
  const save = p.pos;
  if (p.readRegular() === 'xref') return { trailer: readTable(p, entries), isStream: false };
  p.pos = save;
  const { object } = p.parseIndirect();
  if (!(object instanceof PdfStream) || !isName(object.dict.get('Type'), 'XRef')) throw new XrefError(`no xref at ${offset}`);
  readStream(object, entries);
  return { trailer: object.dict, isStream: true };
}

function readTable(p: Parser, entries: Map<number, XrefEntry>): PdfDict {
  const b = p.bytes;
  let first = true;
  for (;;) {
    p.skipSpace();
    const save = p.pos;
    const word = p.readRegular();
    if (word === 'trailer') break;
    if (!/^\d+$/.test(word)) {
      if (word.startsWith('trailer')) {
        p.pos = save + 7;
        break;
      }
      throw new PdfSyntaxError('bad xref subsection', save);
    }
    let start = Number(word);
    p.skipSpace();
    const count = Number(p.readRegular());
    if (!Number.isInteger(count)) throw new PdfSyntaxError('bad xref subsection count', p.pos);
    for (let i = 0; i < count; i++) {
      p.skipSpace();
      const off = p.readRegular();
      p.skipSpace();
      const gen = p.readRegular();
      p.skipSpace();
      const kind = b[p.pos];
      if ((kind !== 0x6e && kind !== 0x66) || !/^\d+$/.test(off)) throw new PdfSyntaxError('bad xref entry', p.pos);
      p.pos++;
      // A common off-by-one: a table starting "1 n" whose first entry is object 0's free head.
      if (first && i === 0 && start === 1 && kind === 0x66 && gen === '65535') start = 0;
      const num = start + i;
      if (!entries.has(num)) {
        entries.set(num, kind === 0x6e ? { type: 1, offset: Number(off), gen: Number(gen) } : { type: 0 });
      }
    }
    first = false;
  }
  const trailer = p.parseObject();
  if (!(trailer instanceof PdfDict)) throw new XrefError('trailer is not a dictionary');
  return trailer;
}

function readStream(stream: PdfStream, entries: Map<number, XrefEntry>): void {
  const d = stream.dict;
  const w = d.get('W');
  // Field widths must be whole bytes (at most 8, beyond any file offset) and at least one
  // nonzero: an all-zero row would never consume data, and /Size could be in the billions.
  const valid = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 8;
  if (!Array.isArray(w) || w.length < 3 || !w.every(valid) || !(w[0] + w[1] + w[2])) throw new XrefError('bad /W in xref stream');
  const [w0, w1, w2] = w as number[];
  const size = d.number('Size') ?? 0;
  const index = d.get('Index');
  const ranges = Array.isArray(index) ? (index.filter((x) => typeof x === 'number') as number[]) : [0, size];
  const data = decodeStream(stream).data;
  const rowLen = w0 + w1 + w2;
  let pos = 0;
  const field = (width: number): number => {
    let v = 0;
    for (let k = 0; k < width; k++) v = v * 256 + data[pos++];
    return v;
  };
  for (let r = 0; r + 1 < ranges.length; r += 2) {
    for (let i = 0; i < ranges[r + 1]; i++) {
      if (pos + rowLen > data.length) return;
      const num = ranges[r] + i;
      const type = w0 ? field(w0) : 1;
      const f1 = field(w1);
      const f2 = field(w2);
      if (entries.has(num)) continue;
      if (type === 0) entries.set(num, { type: 0 });
      else if (type === 1) entries.set(num, { type: 1, offset: f1, gen: f2 });
      else if (type === 2) entries.set(num, { type: 2, stream: f1, index: f2 });
      // other types are reserved: treated as null objects
    }
  }
}

/**
 * Rebuilds the xref by scanning for `n g obj`, as viewers do for damaged files. The last
 * definition of an object wins (later ones are incremental updates). Objects inside object
 * streams are indexed too, unless an uncompressed definition exists.
 */
export function reconstructXref(bytes: Uint8Array): XrefData {
  const entries = new Map<number, XrefEntry>();
  const objStreams: number[] = [];
  let trailer: PdfDict | undefined;
  const text = latin1(bytes, 0, bytes.length);
  const re = /(\d{1,10})[\0\t\n\f\r ]+(\d{1,5})[\0\t\n\f\r ]+obj\b/g;
  const trailers: PdfDict[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // Must start a token (not the tail of a longer number).
    if (m.index > 0 && isRegular(bytes[m.index - 1])) continue;
    const num = Number(m[1]);
    entries.set(num, { type: 1, offset: m.index, gen: Number(m[2]) });
    // Peek at the dictionary to find object streams, xref streams and catalogs.
    const head = text.slice(m.index, m.index + 512);
    if (/\/Type\s*\/ObjStm\b/.test(head)) objStreams.push(num);
    if (/\/Type\s*\/XRef\b/.test(head)) {
      try {
        const obj = new Parser(bytes, m.index).parseIndirect().object;
        if (obj instanceof PdfStream) trailers.push(obj.dict);
      } catch {
        // ignore
      }
    }
  }
  for (let at = text.indexOf('trailer'); at >= 0; at = text.indexOf('trailer', at + 7)) {
    try {
      const p = new Parser(bytes, at + 7);
      const t = p.parseObject();
      if (t instanceof PdfDict) trailers.push(t);
    } catch {
      // ignore
    }
  }
  // Newest trailer with a Root wins; fill gaps from others.
  for (let i = trailers.length - 1; i >= 0; i--) {
    const t = trailers[i];
    if (!trailer) {
      if (t.has('Root')) trailer = new PdfDict([...t].filter(([k]) => !['Prev', 'XRefStm', 'W', 'Index', 'Filter', 'DecodeParms', 'Length', 'Type', 'Size'].includes(k)));
    } else for (const key of ['Info', 'Encrypt', 'ID']) if (!trailer.has(key) && t.has(key)) trailer.set(key, t.get(key));
  }
  for (const stm of objStreams) {
    const entry = entries.get(stm);
    if (entry?.type !== 1) continue;
    try {
      const obj = new Parser(bytes, entry.offset).parseIndirect().object;
      if (!(obj instanceof PdfStream)) continue;
      const nums = objectStreamIndex(obj);
      nums.forEach(([num], index) => {
        if (!entries.has(num)) entries.set(num, { type: 2, stream: stm, index });
      });
    } catch {
      // ignore damaged object streams
    }
  }
  entries.set(0, { type: 0 });
  return { entries, trailer: trailer ?? new PdfDict(), startxref: -1, usesXrefStream: false };
}

/** An object stream's header: [object number, offset relative to /First] pairs. */
export function objectStreamIndex(stream: PdfStream, data = decodeStream(stream).data): [number, number][] {
  const n = stream.dict.number('N') ?? 0;
  const p = new Parser(data, 0);
  const out: [number, number][] = [];
  // A truncated or damaged header yields the pairs read before the damage.
  try {
    for (let i = 0; i < n && !p.atEnd; i++) {
      const num = p.parseObject();
      const off = p.parseObject();
      if (typeof num !== 'number' || typeof off !== 'number') break;
      out.push([num, off]);
    }
  } catch (e) {
    if (!(e instanceof PdfSyntaxError)) throw e;
  }
  return out;
}

/** Finds the %PDF-x.y header in the first KB; returns its offset and version. */
export function findHeader(bytes: Uint8Array): { offset: number; version: string } | undefined {
  const at = indexOf(bytes.subarray(0, 1024), ascii('%PDF-'));
  if (at < 0) return undefined;
  const m = /^\d\.\d/.exec(latin1(bytes, at + 5, Math.min(bytes.length, at + 8)));
  return { offset: at, version: m ? m[0] : '1.4' };
}

export type { PdfObject };
