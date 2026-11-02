// SPDX-License-Identifier: MIT
// Object serialization (§7.3) into a growable byte buffer.

import { PdfDict, PdfName, PdfRef, PdfStream, PdfString, type PdfObject } from './objects.ts';

export class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  length = 0;

  private ensure(extra: number): void {
    if (this.length + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.length++] = b;
  }

  bytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buf.set(data, this.length);
    this.length += data.length;
  }

  /** ASCII/Latin-1 text, one byte per char. */
  text(s: string): void {
    this.ensure(s.length);
    const buf = this.buf;
    let n = this.length;
    for (let i = 0; i < s.length; i++) buf[n++] = s.charCodeAt(i);
    this.length = n;
  }

  /** The written bytes (a view; copy if the writer will be reused). */
  get data(): Uint8Array {
    return this.buf.subarray(0, this.length);
  }

  /** Last byte written, or -1. */
  get last(): number {
    return this.length ? this.buf[this.length - 1] : -1;
  }
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  // PDF has no exponent syntax, which String() and toFixed() switch to from 1e21.
  if (Math.abs(n) >= 1e21) return BigInt(Math.trunc(n)).toString();
  if (Number.isInteger(n)) return String(n);
  // Six decimals is below device resolution for coordinates and exact enough for colors.
  let s = n.toFixed(6);
  s = s.replace(/\.?0+$/, '');
  if (s.startsWith('0.')) s = s.slice(1);
  else if (s.startsWith('-0.')) s = '-' + s.slice(2);
  return s === '-0' || s === '' || s === '-' ? '0' : s;
}

const NAME_ESCAPE = new Uint8Array(256);
for (let c = 0; c < 256; c++) NAME_ESCAPE[c] = c < 0x21 || c > 0x7e || '#()<>[]{}/%'.includes(String.fromCharCode(c)) ? 1 : 0;

/**
 * A name token. Names are binary strings (one char per byte); a name made from text with
 * characters above U+00FF is written as its UTF-8 bytes rather than truncated.
 */
export function formatName(name: string): string {
  const escape = (b: number) => '#' + b.toString(16).padStart(2, '0');
  let s = '/';
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c > 0xff) {
      const cp = name.codePointAt(i)!;
      if (cp > 0xffff) i++;
      for (const b of new TextEncoder().encode(String.fromCodePoint(cp))) s += escape(b);
    } else s += NAME_ESCAPE[c] ? escape(c) : name[i];
  }
  return s;
}

const HEX_DIGITS = '0123456789ABCDEF';

export function writeString(out: ByteWriter, s: PdfString): void {
  const b = s.bytes;
  if (s.hex) {
    out.byte(0x3c);
    for (const c of b) {
      out.byte(HEX_DIGITS.charCodeAt(c >> 4));
      out.byte(HEX_DIGITS.charCodeAt(c & 15));
    }
    out.byte(0x3e);
    return;
  }
  out.byte(0x28);
  for (const c of b) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) {
      out.byte(0x5c);
      out.byte(c);
    } else if (c === 13) out.text('\\r');
    else if (c === 10) out.text('\\n');
    else out.byte(c);
  }
  out.byte(0x29);
}

export interface SerializeOptions {
  /** Maps references on the way out (renumbering on full save). */
  mapRef?: (ref: PdfRef) => PdfRef;
}

/** Whether a token starting with this byte needs whitespace after a regular-character token. */
const needsSpaceBefore = (o: PdfObject): boolean =>
  o === null || typeof o === 'number' || typeof o === 'boolean' || o instanceof PdfRef;

export function writeObject(out: ByteWriter, o: PdfObject, options: SerializeOptions = {}): void {
  if (o === null) out.text('null');
  else if (typeof o === 'number') out.text(formatNumber(o));
  else if (typeof o === 'boolean') out.text(o ? 'true' : 'false');
  else if (o instanceof PdfName) out.text(formatName(o.name));
  else if (o instanceof PdfString) writeString(out, o);
  else if (o instanceof PdfRef) {
    const r = options.mapRef ? options.mapRef(o) : o;
    out.text(`${r.num} ${r.gen} R`);
  } else if (Array.isArray(o)) {
    out.byte(0x5b);
    for (let i = 0; i < o.length; i++) {
      if (i) out.byte(0x20);
      writeObject(out, o[i], options);
    }
    out.byte(0x5d);
  } else if (o instanceof PdfDict) writeDict(out, o, options);
  else if (o instanceof PdfStream) {
    writeDict(out, o.dict, options, o.data.length);
    out.text('\nstream\n');
    out.bytes(o.data);
    out.text('\nendstream');
  }
}

export function writeDict(out: ByteWriter, d: PdfDict, options: SerializeOptions = {}, streamLength?: number): void {
  out.text('<<');
  for (const [key, value] of d) {
    if (streamLength !== undefined && key === 'Length') continue;
    out.text(formatName(key));
    if (needsSpaceBefore(value)) out.byte(0x20);
    writeObject(out, value, options);
  }
  if (streamLength !== undefined) out.text(`/Length ${streamLength}`);
  out.text('>>');
}

/** Serializes one object to bytes. */
export function serialize(o: PdfObject, options?: SerializeOptions): Uint8Array {
  const w = new ByteWriter();
  writeObject(w, o, options);
  return w.data.slice();
}
