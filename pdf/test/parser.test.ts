import assert from 'node:assert/strict';
import { test } from 'node:test';
import { N, Parser, PdfDict, PdfName, PdfRef, PdfStream, PdfString, parseContent, serialize, serializeContent, type PdfObject } from '../src/index.ts';
import { ascii, latin1 } from './helpers.ts';

const parse = (s: string): PdfObject => new Parser(ascii(s)).parseObject();

test('numbers, booleans, null', () => {
  assert.deepEqual([parse('42'), parse('-3.5'), parse('+.5'), parse('4.'), parse('-.002'), parse('--5')], [42, -3.5, 0.5, 4, -0.002, -5]);
  assert.deepEqual([parse('true'), parse('false'), parse('null')], [true, false, null]);
});

test('literal strings: escapes, octal, balanced parentheses, line endings', () => {
  const s = parse('(a\\(b\\) (nested) \\101\\60\\0053 tab\\t\\\r\ncontinued\rline)') as PdfString;
  assert.equal(latin1(s.bytes), 'a(b) (nested) A0\x053 tab\tcontinued\nline');
});

test('hex strings: whitespace and an odd final digit', () => {
  const s = parse('<48 65 6C6C 6F7>') as PdfString;
  assert.equal(latin1(s.bytes), 'Hellop');
  assert.equal(s.hex, true);
});

test('text strings: PDFDocEncoding and UTF-16BE', () => {
  assert.equal(PdfString.text('Café').bytes.length, 4);
  assert.equal(PdfString.text('日本').bytes[0], 0xfe);
  for (const t of ['Café – “x” €', '日本語 🎉']) assert.equal(PdfString.text(t).text, t);
});

test('names: #xx escapes, interning, serialization', () => {
  const n = parse('/A#20B#2Fc') as PdfName;
  assert.equal(n.name, 'A B/c');
  assert.equal(n, N('A B/c'));
  assert.equal(latin1(serialize(n)).toLowerCase(), '/a#20b#2fc');
});

test('dictionaries, arrays and references', () => {
  const d = parse('<< /Type /Page /Kids [1 0 R 2 0 R 3] /Nested << /A [<<>>] >> /Null null >>') as PdfDict;
  assert.equal(d.name('Type'), 'Page');
  const kids = d.get('Kids') as PdfObject[];
  assert.ok(kids[0] instanceof PdfRef && kids[0].num === 1);
  assert.equal(kids[2], 3);
  assert.ok(d.get('Nested') instanceof PdfDict);
  assert.equal(d.has('Null'), false); // a null value means the key is absent
});

test('streams with a wrong /Length are recovered from endstream', () => {
  for (const length of ['5', '999', '2 0 R']) {
    const src = `7 0 obj << /Length ${length} >> stream\r\nhello world\r\nendstream endobj`;
    const r = new Parser(ascii(src)).parseIndirect();
    assert.equal(r.num, 7);
    assert.equal(latin1((r.object as PdfStream).data), 'hello world', `/Length ${length}`);
  }
});

test('serialize → parse round trip', () => {
  const d = new PdfDict({
    Type: N('Test'),
    S: new PdfString(ascii('a(b)\\c\r\n')),
    H: new PdfString(Uint8Array.of(0, 255), true),
    A: [1, -2.5, 0.000001, true, null, new PdfRef(3, 1)],
    D: new PdfDict({ X: 1 }),
  });
  const back = parse(latin1(serialize(d))) as PdfDict;
  assert.equal(latin1((back.get('S') as PdfString).bytes), 'a(b)\\c\r\n');
  assert.deepEqual((back.get('H') as PdfString).bytes, Uint8Array.of(0, 255));
  const a = back.get('A') as PdfObject[];
  assert.deepEqual(a.slice(0, 5), [1, -2.5, 0.000001, true, null]);
  assert.ok((a[5] as PdfRef).equals(new PdfRef(3, 1)));
});

test('content streams, including inline images containing "EI"', () => {
  const src = 'q 1 0 0 1 72 72 cm BT /F1 12 Tf (Hi) Tj [(A) -120 (B)] TJ ET\nBI /W 2 /H 1 /BPC 8 /CS /G ID \x00EI\x01\x02\nEI Q'; // no /L: found by scanning
  const ops = parseContent(ascii(src));
  assert.deepEqual(
    ops.map((o) => o.op),
    ['q', 'cm', 'BT', 'Tf', 'Tj', 'TJ', 'ET', 'BI', 'Q'],
  );
  const bi = ops[7];
  assert.equal(latin1(bi.data!), '\x00EI\x01\x02');
  const again = parseContent(serializeContent(ops));
  assert.deepEqual(
    again.map((o) => o.op),
    ops.map((o) => o.op),
  );
  assert.equal(latin1(again[7].data!), '\x00EI\x01\x02');
});

test('damaged content ends the operation list instead of throwing', () => {
  const ops = parseContent(ascii('BT (unterminated Tj ET'));
  assert.ok(Array.isArray(ops));
});
