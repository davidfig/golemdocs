// Pictures in RTF, HTML (data: URIs), EPUB and MHTML (src/formats/images.ts and the four formats).

import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { WordDocument, ZipArchive } from '@word/docx';
import type { Drawing, Inline, Paragraph } from '@word/docx';
import { epub, mhtml } from '../src/formats/handlers/webArchives.ts';
import html from '../src/formats/handlers/html.ts';
import rtf from '../src/formats/handlers/rtf.ts';
import { collectImages, decodeDataUri, sniffImage } from '../src/formats/images.ts';
import { sniffType } from '../src/shapes/imageRenderer.ts';

const fonts = undefined as never;

function png(width: number, height: number, shade: number): Uint8Array {
  const crc = (buf: Buffer) => {
    let crc = 0xffffffff;
    for (const b of buf) {
      let c = (crc ^ b) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height, shade);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/** The smallest byte string that reads as a JPEG of the given size (headers only). */
function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, 0, 0, 0, 0]);
}

async function withPictures(...pictures: { bytes: Uint8Array; ext: string; width: number; height: number }[]): Promise<WordDocument> {
  const doc = await WordDocument.create();
  const inline = (text: string): Inline => ({ kind: 'run', properties: {}, content: [{ kind: 'text', text }], attrs: {} });
  const drawings = pictures.map<Inline>((p) => ({
    kind: 'run',
    properties: {},
    attrs: {},
    content: [{ kind: 'drawing', inline: true, width: p.width, height: p.height, image: doc.addImage(p.bytes, p.ext), description: 'alt text' }],
  }));
  doc.body = [{ kind: 'paragraph', properties: {}, attrs: {}, children: [inline('Before '), ...drawings.flatMap((d) => [d, inline(' between ')]), inline('after')] }];
  return doc;
}

const drawingsOf = (doc: WordDocument): Drawing[] =>
  (doc.body[0] as Paragraph).children.flatMap((c) => (c.kind === 'run' ? c.content : [])).filter((c): c is Drawing => c.kind === 'drawing');

async function bytesOf(doc: WordDocument): Promise<Uint8Array[]> {
  return Promise.all(drawingsOf(doc).map((d) => doc.media(d.image!)));
}

const A = png(40, 30, 200);
const B = jpeg(64, 48);
const EMU = 9525;
const source = () => withPictures({ bytes: A, ext: 'png', width: 40 * EMU, height: 30 * EMU }, { bytes: B, ext: 'jpeg', width: 128 * EMU, height: 96 * EMU });

test('pictures are recognised by their bytes, with their pixel size', () => {
  assert.deepEqual([sniffImage(A)?.type, sniffImage(A)?.width, sniffImage(A)?.height], ['png', 40, 30]);
  assert.deepEqual([sniffImage(B)?.type, sniffImage(B)?.width, sniffImage(B)?.height], ['jpeg', 64, 48]);
  assert.equal(sniffImage(new TextEncoder().encode('not a picture at all')), null);
  assert.deepEqual([...decodeDataUri('data:text/plain;base64,aGk=')!], [104, 105]);
  assert.equal(decodeDataUri('https://example.com/a.png'), null);
});

test('RTF: PNG and JPEG pictures keep their bytes and size', async () => {
  const doc = await source();
  const back = (await rtf.read(await rtf.write(doc, {}, fonts))).document;
  const drawings = drawingsOf(back);
  assert.equal(drawings.length, 2);
  assert.deepEqual(drawings.map((d) => [d.width, d.height]), [[40 * EMU, 30 * EMU], [128 * EMU, 96 * EMU]]);
  assert.deepEqual(await bytesOf(back), [A, B]);
});

test('HTML: pictures are written as data: URIs and read back', async () => {
  const doc = await source();
  const file = new TextDecoder().decode(await html.write(doc, {}, fonts));
  assert.equal([...file.matchAll(/<img src="data:image\/(png|jpeg);base64,/g)].length, 2);
  assert.ok(file.includes('width="40" height="30"'));
  assert.ok(file.includes('alt="alt text"'));
  const back = (await html.read(new TextEncoder().encode(file))).document;
  assert.deepEqual(await bytesOf(back), [A, B]);
  assert.deepEqual(drawingsOf(back).map((d) => [d.width, d.height, d.description]), [[40 * EMU, 30 * EMU, 'alt text'], [128 * EMU, 96 * EMU, 'alt text']]);
});

test('HTML: a picture without bytes stays a placeholder; an unsized picture uses its own size and fits the page', async () => {
  const placeholder = (await html.read(new TextEncoder().encode('<p><img src="missing.png" alt="gone"></p>'))).document;
  assert.equal(drawingsOf(placeholder).length, 0);
  const big = png(2000, 1000, 10);
  const uri = `data:image/png;base64,${Buffer.from(big).toString('base64')}`;
  const doc = (await html.read(new TextEncoder().encode(`<p><img src="${uri}"></p>`))).document;
  const [d] = drawingsOf(doc);
  assert.equal(d.width, 624 * EMU);
  assert.equal(d.height, 312 * EMU);
  // The same picture twice is stored once.
  const twice = (await html.read(new TextEncoder().encode(`<p><img src="${uri}"><img src="${uri}" width="100"></p>`))).document;
  assert.equal(new Set(drawingsOf(twice).map((x) => x.image)).size, 1);
  assert.equal(drawingsOf(twice)[1].height, 50 * EMU);
});

test('EPUB: pictures travel as files in the book and come back', async () => {
  const doc = await source();
  const book = await epub.write(doc, {}, fonts);
  const zip = ZipArchive.read(book);
  assert.ok(zip.entries.has('OEBPS/images/image1.png'));
  assert.ok(zip.entries.has('OEBPS/images/image2.jpg'));
  const opf = await zip.entries.get('OEBPS/content.opf')!.text();
  assert.ok(opf.includes('href="images/image1.png" media-type="image/png"'));
  assert.ok(opf.includes('href="images/image2.jpg" media-type="image/jpeg"'));
  const chapter = await zip.entries.get('OEBPS/chapter.xhtml')!.text();
  assert.ok(chapter.includes('src="images/image1.png"'));
  assert.ok(!chapter.includes('data:'));
  const back = (await epub.read(book)).document;
  assert.deepEqual(await bytesOf(back), [A, B]);
  assert.deepEqual(drawingsOf(back).map((d) => d.width), [40 * EMU, 128 * EMU]);
});

test('EPUB: pictures in other folders of a book, and with escaped names, are found', async () => {
  const { writeZip } = await import('@word/docx');
  const enc = new TextEncoder();
  const f = (name: string, data: string | Uint8Array) => ({ name, data: typeof data === 'string' ? enc.encode(data) : data });
  const book = await writeZip([
    f('mimetype', 'application/epub+zip'),
    f('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book/pack.opf"/></rootfiles></container>'),
    f('book/pack.opf', '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="a" href="text/a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>'),
    f('book/text/a.xhtml', '<html><body><p>Pic: <img src="../art/my%20pic.png" alt="x"/></p></body></html>'),
    f('book/art/my pic.png', A),
  ]);
  const doc = (await epub.read(book)).document;
  assert.deepEqual(await bytesOf(doc), [A]);
});

test('MHTML: pictures travel as message parts and come back', async () => {
  const doc = await source();
  const file = await mhtml.write(doc, {}, fonts);
  const text = new TextDecoder().decode(file);
  assert.ok(/^[\x00-\x7f]*$/.test(text));
  assert.equal([...text.matchAll(/Content-Type: image\//g)].length, 2);
  assert.ok(text.includes('Content-Location: file:///images/image1.png'));
  const back = (await mhtml.read(file)).document;
  assert.deepEqual(await bytesOf(back), [A, B]);
});

test('MHTML: pictures found by absolute address, relative address or cid', async () => {
  const b64 = Buffer.from(A).toString('base64');
  const message = [
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; type="text/html"; boundary="B"',
    '',
    '--B',
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: 7bit',
    'Content-Location: https://example.com/dir/page.html',
    '',
    '<html><body><p><img src="https://example.com/dir/abs.png"><img src="rel.png"><img src="cid:one@x"></p></body></html>',
    ...['https://example.com/dir/abs.png', 'https://example.com/dir/rel.png'].flatMap((location) => ['--B', 'Content-Type: image/png', 'Content-Transfer-Encoding: base64', `Content-Location: ${location}`, '', b64]),
    '--B',
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <one@x>',
    '',
    b64,
    '--B--',
    '',
  ].join('\r\n');
  const doc = (await mhtml.read(new TextEncoder().encode(message))).document;
  assert.deepEqual(await bytesOf(doc), [A, A, A]);
});

test('collectImages finds pictures inside links and table cells', async () => {
  const doc = await source();
  const [para] = doc.body as Paragraph[];
  doc.body = [{ kind: 'table', properties: {}, grid: [1000], rows: [{ kind: 'row', properties: {}, attrs: {}, cells: [{ kind: 'cell', properties: {}, attrs: {}, children: [{ ...para, children: [{ kind: 'hyperlink', url: 'x', children: para.children, attrs: {} }] }] }] }] }];
  assert.equal((await collectImages(doc)).size, 2);
});

test('a picture part without an extension (a PDF’s) is recognised by its bytes', () => {
  assert.equal(sniffType(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a)), 'image/png');
  assert.equal(sniffType(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffType(Uint8Array.of(0x25, 0x50, 0x44, 0x46)), '');
});
