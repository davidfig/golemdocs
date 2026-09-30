// Regression tests for malformed and hostile input, and for edge cases of the core reader and writer.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  N,
  Parser,
  PdfDict,
  PdfDocument,
  PdfName,
  PdfRef,
  PdfStream,
  PdfSyntaxError,
  TrueTypeFont,
  FontFormatError,
  decodeStream,
  parseContent,
  serialize,
  serializeContent,
  standardFont,
  readAnnotations,
} from '../src/index.ts';
import { applyPredictor, ascii85Decode, filterChain } from '../src/filters/filters.ts';
import { formatNumber } from '../src/core/serialize.ts';
import { rc4 } from '../src/crypt/primitives.ts';
import { ascii, latin1 } from './helpers.ts';

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/**
 * A file from indirect objects (`bodies`: what goes between "n 0 obj" and "endobj") and objects
 * packed in object streams (`packed`: number to [stream, index]), with an uncompressed xref stream.
 */
function assemble(bodies: Record<number, Uint8Array>, packed: Record<number, [number, number]>, trailer: string): Uint8Array {
  const parts: Uint8Array[] = [ascii('%PDF-1.7\n')];
  let length = parts[0].length;
  const offsets = new Map<number, number>();
  for (const [num, body] of Object.entries(bodies)) {
    offsets.set(Number(num), length);
    const obj = concat(ascii(`${num} 0 obj\n`), body, ascii('\nendobj\n'));
    parts.push(obj);
    length += obj.length;
  }
  const size = Math.max(...offsets.keys(), ...Object.keys(packed).map(Number)) + 2;
  const self = size - 1;
  offsets.set(self, length);
  const rows = new Uint8Array(size * 7);
  const view = new DataView(rows.buffer);
  for (let n = 0; n < size; n++) {
    const off = offsets.get(n);
    const p = packed[n];
    if (off !== undefined) {
      rows[n * 7] = 1;
      view.setUint32(n * 7 + 1, off);
    } else if (p) {
      rows[n * 7] = 2;
      view.setUint32(n * 7 + 1, p[0]);
      view.setUint16(n * 7 + 5, p[1]);
    } else view.setUint16(n * 7 + 5, n ? 0 : 65535);
  }
  parts.push(
    ascii(`${self} 0 obj\n<< /Type /XRef /Size ${size} /W [1 4 2] /Length ${rows.length} ${trailer} >>\nstream\n`),
    rows,
    ascii(`\nendstream\nendobj\nstartxref\n${length}\n%%EOF\n`),
  );
  return concat(...parts);
}

/** An object stream's data: the header of number/offset pairs, then the objects. */
function objectStream(objects: [number, string][]): { data: Uint8Array; first: number } {
  let body = '';
  const header: string[] = [];
  for (const [num, text] of objects) {
    header.push(`${num} ${body.length}`);
    body += text + '\n';
  }
  const head = header.join(' ') + '\n';
  return { data: ascii(head + body), first: head.length };
}

// --- parser -------------------------------------------------------------------------------------

test('a long run of stray delimiters does not overflow the stack', () => {
  const junk = ')'.repeat(200_000) + '> '.repeat(200_000) + ' 42';
  assert.equal(new Parser(ascii(junk)).parseObject(), 42);
});

test('absurdly deep nesting is a syntax error, not a stack overflow', () => {
  const deep = '['.repeat(100_000) + ']'.repeat(100_000);
  assert.throws(() => new Parser(ascii(deep)).parseObject(), PdfSyntaxError);
  const fine = '['.repeat(100) + '1' + ']'.repeat(100);
  let o = new Parser(ascii(fine)).parseObject();
  for (let i = 0; i < 100; i++) o = (o as unknown[])[0] as typeof o;
  assert.equal(o, 1);
  // Content streams end at the damage rather than throwing.
  assert.deepEqual(parseContent(ascii('1 0 0 1 0 0 cm ' + '['.repeat(100_000))).map((op) => op.op), ['cm']);
});

test('numbers too large for plain notation are written without an exponent', () => {
  assert.equal(formatNumber(1e21), '1000000000000000000000');
  assert.equal(formatNumber(-(2 ** 80)), '-1208925819614629174706176');
  assert.equal(new Parser(ascii(formatNumber(1e21))).parseObject(), 1e21);
  assert.equal(formatNumber(12.5), '12.5');
});

test('names with characters above U+00FF are written as UTF-8, not truncated', () => {
  const bytes = serialize(N('Нет/да'));
  assert.equal(latin1(bytes), '/#d0#9d#d0#b5#d1#82#2f#d0#b4#d0#b0');
  const back = new Parser(bytes).parseObject() as PdfName;
  assert.equal(back.text, 'Нет/да');
});

test('inline image keys are escaped like any other name', () => {
  const dict = new PdfDict({ 'W idth': 1 });
  const out = latin1(serializeContent([{ op: 'BI', operands: [dict], data: ascii('x') }]));
  assert.match(out, /BI \/W#20idth 1 ID/);
  assert.equal((parseContent(ascii(out))[0].operands[0] as PdfDict).get('W idth'), 1);
});

test('a stream with no data before endstream is empty', () => {
  const p = new Parser(ascii('1 0 obj << >> stream\nendstream endobj'));
  const { object } = p.parseIndirect();
  assert.ok(object instanceof PdfStream);
  assert.equal(object.data.length, 0);
});

// --- filters ------------------------------------------------------------------------------------

test("ASCII85: runs of 'z' decode in full", () => {
  const out = ascii85Decode(ascii('zzzzzzzzzz~>'));
  assert.equal(out.length, 40);
  assert.ok(out.every((b) => b === 0));
});

test('predictors with nonsense parameters leave the data alone instead of hanging', () => {
  const data = Uint8Array.from([1, 2, 3, 4]);
  assert.deepEqual(applyPredictor(data, 2, 1, 8, 0), data); // zero columns: used to loop forever
  assert.deepEqual(applyPredictor(data, 12, 1, 8, 2 ** 40), data); // would allocate a terabyte
  assert.deepEqual(applyPredictor(data, 12, 1.5, 8, 1), data);
  assert.deepEqual(applyPredictor(data, 12, 1, 3, 1), data);
});

test('filter names are not looked up on Object.prototype', () => {
  const steps = filterChain(new PdfDict({ Filter: [N('constructor'), N('AHx')] }));
  assert.deepEqual(
    steps.map((s) => s.name),
    ['constructor', 'ASCIIHexDecode'],
  );
  const r = decodeStream(new PdfStream(new PdfDict({ Filter: N('toString') }), ascii('abc')));
  assert.deepEqual(r.remaining.map((s) => s.name), ['toString']);
});

// --- xref and documents -------------------------------------------------------------------------

test('an xref stream with zero-width fields is rejected, not iterated a billion times', () => {
  const file = assemble(
    {
      1: ascii('<< /Type /Catalog /Pages 2 0 R >>'),
      2: ascii('<< /Type /Pages /Kids [] /Count 0 >>'),
    },
    {},
    '/Root 1 0 R',
  );
  const bad = latin1(file).replace('/Size 4 /W [1 4 2]', '/Size 999999999 /W [0 0 0]');
  const doc = PdfDocument.load(ascii(bad));
  assert.equal(doc.recovered, true);
  assert.equal(doc.pageCount, 0);
});

test('a file with more objects than fit in a function call opens', () => {
  const count = 200_000;
  const head = '%PDF-1.4\n';
  const catalog = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  const pages = '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n';
  const rows = ['0000000000 65535 f \n', `${String(head.length).padStart(10, '0')} 00000 n \n`, `${String(head.length + catalog.length).padStart(10, '0')} 00000 n \n`];
  const xrefAt = head.length + catalog.length + pages.length;
  const text = head + catalog + pages + `xref\n0 ${count}\n` + rows.join('') + '0000000000 00001 f \n'.repeat(count - 3) + `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  const doc = PdfDocument.load(ascii(text));
  assert.equal(doc.recovered, false);
  assert.equal(doc.pageCount, 0);
  assert.ok(doc.add(null).num >= count);
});

test('an encrypted file whose catalog is in an object stream opens', () => {
  const PAD = Uint8Array.from([
    0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe,
    0x64, 0x53, 0x69, 0x7a,
  ]);
  const md5 = (...parts: Uint8Array[]) => new Uint8Array(createHash('md5').update(concat(...parts)).digest());
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  const id0 = Uint8Array.from({ length: 16 }, (_, i) => i * 7);
  const o = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
  const p = -4;
  // Algorithms 2 and 5 (revision 3, 128-bit RC4) for the empty user password.
  let key = md5(PAD, o, Uint8Array.from([p & 0xff, (p >> 8) & 0xff, (p >> 16) & 0xff, (p >>> 24) & 0xff]), id0);
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, 16));
  key = key.subarray(0, 16);
  let u = rc4(key, md5(PAD, id0));
  for (let i = 1; i <= 19; i++) u = rc4(key.map((b) => b ^ i), u);
  const objectKey = (num: number) => md5(key, Uint8Array.from([num & 0xff, (num >> 8) & 0xff, 0, 0, 0])).subarray(0, 16);

  const stm = objectStream([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [] /Count 0 >>'],
    [4, '<< /Title (Inside) >>'],
  ]);
  const file = assemble(
    {
      3: concat(ascii(`<< /Type /ObjStm /N 3 /First ${stm.first} /Length ${stm.data.length} >>\nstream\n`), rc4(objectKey(3), stm.data), ascii('\nendstream')),
      5: ascii(`<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${p} /O <${hex(o)}> /U <${hex(u)}${'00'.repeat(16)}> >>`),
    },
    { 1: [3, 0], 2: [3, 1], 4: [3, 2] },
    `/Root 1 0 R /Info 4 0 R /Encrypt 5 0 R /ID [<${hex(id0)}> <${hex(id0)}>]`,
  );
  const doc = PdfDocument.load(file);
  assert.equal(doc.recovered, false);
  assert.ok(doc.security);
  assert.equal(doc.catalog.name('Type'), 'Catalog');
  assert.equal(doc.getMetadata('Title'), 'Inside');
});

test('a page written directly in /Kids gets a reference its parent holds', () => {
  const doc = PdfDocument.create();
  const pagesRef = doc.catalog.get('Pages') as PdfRef;
  const pages = doc.dict(pagesRef)!;
  const direct = new PdfDict({ Type: N('Page'), Parent: pagesRef, MediaBox: [0, 0, 100, 100] });
  pages.set('Kids', [direct]).set('Count', 1);
  doc.invalidatePages();
  const page = doc.pages[0];
  assert.ok((pages.get('Kids') as unknown[])[0] instanceof PdfRef);
  assert.equal(page.index, 0);
  doc.addPage();
  assert.equal(doc.pageCount, 2);
  doc.removePage(0); // used to fail: the page's new reference wasn't in its parent's Kids
  assert.equal(doc.pageCount, 1);
});

// --- fonts and annotations ----------------------------------------------------------------------

test('font and annotation types are not looked up on Object.prototype', () => {
  assert.equal(standardFont('constructor'), undefined);
  assert.equal(standardFont('toString'), undefined);
  assert.equal(standardFont('Arial')?.name, 'Helvetica');
  const doc = PdfDocument.create();
  const page = doc.addPage();
  page.dict.set('Annots', [doc.add(new PdfDict({ Type: N('Annot'), Subtype: N('constructor'), Rect: [0, 0, 1, 1] }))]);
  assert.deepEqual(readAnnotations(doc), []);
});

test('a truncated font file is a FontFormatError', () => {
  assert.throws(() => TrueTypeFont.parse(ascii('true\0')), FontFormatError);
  assert.throws(() => TrueTypeFont.parse(new Uint8Array(0)), FontFormatError);
});
