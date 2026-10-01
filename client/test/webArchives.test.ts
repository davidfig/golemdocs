// EPUB and MHTML import/export (src/formats/epub.ts, mhtml.ts, handlers/webArchives.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZipArchive, paragraphText } from '@golemdocs/docx';
import type { Paragraph } from '@golemdocs/docx';
import { epub, mhtml } from '../src/formats/handlers/webArchives.ts';
import { markdownToDocument } from '../src/formats/markdown.ts';
import { parseXml } from '@golemdocs/docx';

const texts = (doc: { body: { kind: string }[] }) =>
  (doc.body as Paragraph[]).filter((b) => b.kind === 'paragraph').map(paragraphText).filter(Boolean);

test('an EPUB written from a document reads back, and is well-formed XHTML', async () => {
  const source = await markdownToDocument('# Title\n\nSome **bold** text with a break.\\\nSecond line & <angles>.\n\n---\n\nEnd.\n');
  const bytes = await epub.write(source, {}, undefined as never);
  const zip = ZipArchive.read(bytes);
  assert.deepEqual([...zip.entries.keys()].slice(0, 2), ['mimetype', 'META-INF/container.xml']);
  for (const name of ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/chapter.xhtml']) {
    const text = await zip.entries.get(name)!.text();
    assert.doesNotThrow(() => parseXml(text), name);
  }
  const back = (await epub.read(bytes)).document;
  assert.deepEqual(texts(back), texts(source));
});

test('an EPUB is read in spine order', async () => {
  const { writeZip } = await import('@golemdocs/docx');
  const enc = new TextEncoder();
  const f = (name: string, s: string) => ({ name, data: enc.encode(s) });
  const bytes = await writeZip([
    f('mimetype', 'application/epub+zip'),
    f('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book/pack.opf"/></rootfiles></container>'),
    f('book/pack.opf', '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="a" href="text/a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="text/b%20b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>'),
    f('book/text/a.xhtml', '<html><body><p>Alpha</p></body></html>'),
    f('book/text/b b.xhtml', '<html><body><p>Beta</p></body></html>'),
  ]);
  assert.deepEqual(texts((await epub.read(bytes)).document), ['Beta', 'Alpha']);
});

test('MHTML round-trips, including non-ASCII text', async () => {
  const source = await markdownToDocument('# Café\n\nNaïve “text” €5.\n');
  const bytes = await mhtml.write(source, {}, undefined as never);
  assert.ok(/^[\x00-\x7f]*$/.test(new TextDecoder().decode(bytes)));
  assert.deepEqual(texts((await mhtml.read(bytes)).document), texts(source));
});

test('MHTML reads quoted-printable HTML from a browser-style message', async () => {
  const message = [
    'From: <Saved by Blink>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; type="text/html"; boundary="B"',
    '',
    '--B',
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    '',
    'iVBORw0KGgo=',
    '--B',
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<html><body><p>Caf=C3=A9 and a very long line that is soft-wrapped like a mail cl=',
    'ient does it</p></body></html>',
    '--B--',
    '',
  ].join('\r\n');
  const doc = (await mhtml.read(new TextEncoder().encode(message))).document;
  assert.deepEqual(texts(doc), ['Café and a very long line that is soft-wrapped like a mail client does it']);
});

test('non-MHTML input is rejected', async () => {
  await assert.rejects(() => mhtml.read(new TextEncoder().encode('just some words')));
  await assert.rejects(() => epub.read(new TextEncoder().encode('just some words')));
});

test('comments survive EPUB and MHTML', async () => {
  const source = await markdownToDocument('Some {==text==}{>>@Ann: line 1\\nline 2 "q"<<} here.');
  for (const handler of [epub, mhtml]) {
    const back = (await handler.read(await handler.write(source, {}, undefined as never))).document;
    assert.deepEqual(back.comments.map(({ initials: _i, ...c }) => c), source.comments.map(({ initials: _i, ...c }) => c));
  }
});

test('a book with a stray % in an address or no spine is read or refused, not crashed on', async () => {
  const { writeZip } = await import('@golemdocs/docx');
  const enc = new TextEncoder();
  const f = (name: string, s: string) => ({ name, data: enc.encode(s) });
  const container = f('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="pack.opf"/></rootfiles></container>');
  const book = await writeZip([
    f('mimetype', 'application/epub+zip'),
    container,
    f('pack.opf', '<package><manifest><item id="a" href="100%.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>'),
    f('100%.xhtml', '<html><body><p>Full</p></body></html>'),
  ]);
  assert.deepEqual(texts((await epub.read(book)).document), ['Full']);
  const noSpine = await writeZip([f('mimetype', 'application/epub+zip'), container, f('pack.opf', '<package><metadata/></package>')]);
  await assert.rejects(epub.read(noSpine), /no readable chapters/);
});

test('XHTML for a book gives each valueless data- attribute a value, and leaves quoted text alone', async () => {
  const { xhtmlize } = await import('../src/formats/epub.ts');
  assert.equal(
    xhtmlize('<mark data-comment="see data-x here" data-a data-b>t</mark><style data-word-styles>'),
    '<mark data-comment="see data-x here" data-a="" data-b="">t</mark><style data-word-styles="">',
  );
});
