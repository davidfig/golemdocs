import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PasswordError, PdfDocument, PdfString, parseDate, formatDate } from '../src/index.ts';
import { ascii, checkXrefTables, docText, fixture, latin1, LINE1, LINE2, load } from './helpers.ts';

const BOTH = `${LINE1} ${LINE2}`;

// --- reading ------------------------------------------------------------------------------------

test('text from every producer', () => {
  const expected: Record<string, string> = {
    'libreoffice.pdf': BOTH,
    'xelatex.pdf': BOTH,
    'chromium.pdf': BOTH,
    'wkhtmltopdf.pdf': BOTH,
    // matplotlib draws characters above U+00FF as paths, not text.
    'matplotlib-type3.pdf': `${LINE1} Café naïve résumé quoted fi fl 1234`,
    'matplotlib-type42.pdf': BOTH,
    // Type 3 bitmap fonts in TeX's T1 encoding: the dash, quotes and ligatures are unmappable.
    'pdflatex.pdf': `${LINE1} Café naïve résumé quoted 1234`,
    'reportlab.pdf': `${LINE1} ${LINE2} Second page`,
    'image.pdf': '',
    'objstm.pdf': BOTH,
    'linearized.pdf': BOTH,
    'qdf.pdf': BOTH,
  };
  for (const [file, text] of Object.entries(expected)) {
    const doc = load(file);
    assert.equal(docText(doc), text, file);
    assert.deepEqual(doc.warnings, [], file);
  }
});

test('text items carry positions and sizes', () => {
  const [first] = load('reportlab.pdf').pages[0].extractText().items;
  assert.equal(first.text, LINE1);
  assert.deepEqual([first.x, first.y, first.fontSize, first.fontName], [72, 720, 12, 'Helvetica']);
  assert.ok(Math.abs(first.width - 240.768) < 1e-9); // Helvetica AFM widths (reportlab agrees)
});

test('encrypted with every standard handler revision', () => {
  for (const file of ['rc4-40.pdf', 'rc4-128.pdf', 'aes-128.pdf', 'aes-256-r5.pdf', 'aes-256.pdf']) {
    const user = load(file, { password: 'user' });
    assert.equal(docText(user), BOTH, `${file} user`);
    assert.equal(user.security?.isOwner, false);
    const owner = load(file, { password: 'owner' });
    assert.equal(docText(owner), BOTH, `${file} owner`);
    assert.equal(owner.security?.isOwner, true);
    assert.throws(() => load(file), PasswordError, `${file} without a password`);
    assert.throws(() => load(file, { password: 'wrong' }), PasswordError);
  }
  assert.equal(docText(load('aes-256-owner-only.pdf')), BOTH);
  assert.equal(docText(load('aes-256-unicode.pdf', { password: 'pässwörd' })), BOTH);
  assert.equal(docText(load('aes-256-unicode.pdf', { password: 'pa\u0308sswo\u0308rd' })), BOTH, 'decomposed form, same password');
});

test('encrypted documents save decrypted', async () => {
  const doc = load('aes-256.pdf', { password: 'user' });
  const plain = PdfDocument.load(await doc.save());
  assert.equal(plain.security, undefined);
  assert.equal(docText(plain), BOTH);
});

test('metadata', async () => {
  const doc = PdfDocument.create();
  doc.addPage();
  const when = new Date(Date.UTC(2026, 8, 28, 15, 30, 5));
  doc.setMetadata('Title', 'Ünïcode — 日本語');
  doc.setMetadata('Author', 'David');
  doc.setMetadata('CreationDate', when);
  const back = PdfDocument.load(await doc.save());
  assert.equal(back.getMetadata('Title'), 'Ünïcode — 日本語');
  assert.equal(back.getMetadata('Author'), 'David');
  assert.equal(parseDate(back.getMetadata('CreationDate')!)?.getTime(), when.getTime());
  assert.equal(parseDate("D:20260928153005+02'00'")?.toISOString(), '2026-09-28T13:30:05.000Z');
  assert.match(formatDate(when), /^D:\d{14}(Z|[+-]\d\d'\d\d')$/);
});

// --- saving -------------------------------------------------------------------------------------

test('full save: with and without object streams, compressed or not', async () => {
  const src = load('libreoffice.pdf');
  for (const options of [{}, { objectStreams: false }, { objectStreams: false, compress: false }]) {
    const bytes = await src.save(options);
    const doc = PdfDocument.load(bytes);
    assert.equal(docText(doc), BOTH, JSON.stringify(options));
    assert.deepEqual(doc.warnings, []);
    assert.equal(doc.recovered, false);
    if (options.objectStreams === false) assert.ok(checkXrefTables(bytes) > 5);
  }
});

test('full save drops unreachable objects', async () => {
  const doc = load('libreoffice.pdf');
  const orphan = doc.add(new PdfString(ascii('orphan')));
  const back = PdfDocument.load(await doc.save({ objectStreams: false, compress: false }));
  assert.ok(!latin1(await back.save({ objectStreams: false, compress: false })).includes('orphan'));
  assert.ok(orphan.num > 0);
});

test('incremental save appends to the original bytes, for tables and xref streams', async () => {
  for (const file of ['libreoffice.pdf', 'objstm.pdf']) {
    const original = fixture(file);
    const doc = PdfDocument.load(original);
    doc.setMetadata('Title', 'Changed');
    doc.pages[0].draw().text('Added', 72, 72, { font: doc.standardFont('Helvetica'), size: 12 }).finish();
    const bytes = await doc.save({ incremental: true });
    assert.deepEqual(bytes.subarray(0, original.length), original, `${file}: original bytes kept`);
    const back = PdfDocument.load(bytes);
    assert.equal(back.getMetadata('Title'), 'Changed');
    assert.equal(docText(back), `${BOTH} Added`);
    assert.deepEqual(back.warnings, []);
    if (file === 'libreoffice.pdf') assert.ok(checkXrefTables(bytes) > 0);
  }
});

test('incremental save with nothing changed returns the original', async () => {
  const original = fixture('libreoffice.pdf');
  const doc = PdfDocument.load(original);
  docText(doc); // loads objects without changing them
  const bytes = await doc.save({ incremental: true });
  assert.deepEqual(bytes.subarray(0, original.length), original);
  assert.ok(bytes.length - original.length <= 1);
});

test('incremental save frees deleted objects', async () => {
  const doc = load('libreoffice.pdf');
  const info = doc.trailer.get('Info');
  const ref = doc.add(new PdfString(ascii('temp')));
  const first = PdfDocument.load(await doc.save({ incremental: true }));
  assert.ok(first.get(ref) instanceof PdfString);
  first.delete(ref);
  const second = PdfDocument.load(await first.save({ incremental: true }));
  assert.equal(second.get(ref), null);
  assert.ok(info !== undefined);
});

// --- damaged files --------------------------------------------------------------------------------

test('a wrong startxref is repaired by scanning', () => {
  const bytes = fixture('libreoffice.pdf').slice();
  const text = latin1(bytes);
  const at = text.lastIndexOf('startxref') + 10;
  bytes.set(ascii('999'), at); // points at garbage now
  const doc = PdfDocument.load(bytes);
  assert.equal(doc.recovered, true);
  assert.equal(docText(doc), BOTH);
});

test('a missing xref and trailer are rebuilt', () => {
  const bytes = fixture('qdf.pdf');
  const cut = latin1(bytes).lastIndexOf('\nxref');
  const doc = PdfDocument.load(bytes.subarray(0, cut));
  assert.equal(doc.recovered, true);
  assert.equal(docText(doc), BOTH);
});

test('junk before the header shifts every offset', () => {
  const src = fixture('libreoffice.pdf');
  const junk = ascii('garbage from a mail gateway\r\n');
  const bytes = new Uint8Array(junk.length + src.length);
  bytes.set(junk);
  bytes.set(src, junk.length);
  const doc = PdfDocument.load(bytes);
  assert.equal(docText(doc), BOTH);
});

test('not a PDF', () => {
  assert.throws(() => PdfDocument.load(ascii('hello')), /not a PDF/);
});

// --- pages ---------------------------------------------------------------------------------------

test('adding, removing and moving pages', async () => {
  const doc = PdfDocument.create();
  const font = doc.standardFont('Helvetica');
  for (const label of ['A', 'B', 'C', 'D']) doc.addPage([300, 400]).draw().text(label, 10, 10, { font, size: 12 }).finish();
  doc.movePage(3, 0); // D A B C
  doc.removePage(2); // D A C
  doc.addPage([200, 200], 1).draw().text('X', 10, 10, { font, size: 12 }).finish(); // D X A C
  const back = PdfDocument.load(await doc.save());
  assert.deepEqual(
    back.pages.map((p) => p.extractText().text),
    ['D', 'X', 'A', 'C'],
  );
  assert.deepEqual(back.pages[1].size, { width: 200, height: 200 });
  assert.equal(back.catalog.get('Pages') !== undefined, true);
  assert.equal(back.dict(back.catalog.get('Pages'))?.number('Count'), 4);
});

test('copying pages between documents, with inherited attributes', async () => {
  const src = load('reportlab.pdf');
  const dst = PdfDocument.create();
  dst.addPage();
  dst.copyPages(src, [1, 0], 0);
  dst.copyPages(dst, [0]); // a page of the same document
  const back = PdfDocument.load(await dst.save());
  assert.deepEqual(
    back.pages.map((p) => p.extractText().text.trim()),
    ['Second page', `${LINE1}\n${LINE2}`, '', 'Second page'],
  );
});

test('rotation and boxes', () => {
  const doc = PdfDocument.create();
  const page = doc.addPage([612, 792]);
  page.rotation = 90;
  page.cropBox = [10, 20, 600, 780];
  assert.deepEqual(page.size, { width: 760, height: 590 });
  page.rotation = -90;
  assert.equal(page.rotation, 270);
  assert.deepEqual(page.toDisplay(10, 780), [0, 590]);
});
