// A document on disk and in the account (src/desktop/vaultCodec.ts), with the real converters.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WordDocument } from '@golemdocs/docx';
import { FontSet } from '@golemdocs/layout';
import { PageDrawing, PdfDocument, type PdfEdit } from '../../pdf/src/index.ts';
import { fromVaultFile, toVaultFile, vaultFormat, type VaultFonts } from '../src/desktop/vaultCodec.ts';
import { isWdoc, readWdoc, writeWdoc, WDOC_VERSION, type Extensions } from '../src/formats/wdoc.ts';
import { sceneToObjects } from '../src/vector/nodes.ts';
import { readSvg } from '../src/vector/svgRead.ts';
import { FakeCanvas, installFakeCanvas } from './fakeCanvas.ts';

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array | null) => new TextDecoder().decode(b ?? new Uint8Array());

test('the vault keeps every file the app opens, each in the format the app edits it as', () => {
  for (const name of ['a.md', 'a.markdown', 'a.txt', 'notes.log', 'a.docx', 'a.odt', 'a.html', 'a.csv', 'a.tex', 'a.xml', 'a.epub', 'a.mhtml', 'a.pdf']) assert.notEqual(vaultFormat(name), null, name);
  const as = { 'a.png': 'png', 'a.jpg': 'jpeg', 'a.JPEG': 'jpeg', 'a.webp': 'webp', 'a.gif': 'png', 'a.bmp': 'png', 'a.heic': 'jpeg', 'a.heif': 'jpeg', 'a.svg': 'svg', 'a.svgz': 'svgz', 'a.doc': 'docx', 'a.pdf': 'pdf', 'a.epub': 'epub' };
  for (const [name, format] of Object.entries(as)) assert.equal(vaultFormat(name), format, name);
  for (const name of ['a.zip', 'a.wdoc', 'noextension']) assert.equal(vaultFormat(name), null, name);
});

test('Markdown goes into the account as a document and comes back out as the same Markdown', async () => {
  const source = '---\ntitle: Trip\n---\n\n# Plan\n\nPack **light** and bring a [map](https://example.com).\n\n- tea\n- bread\n';
  const stored = await fromVaultFile(text(source), 'Trip.md');
  assert.ok(isWdoc(stored), 'kept as the app keeps documents');
  const wdoc = await readWdoc(stored);
  assert.equal(wdoc.manifest.lens, 'md');
  assert.equal(wdoc.manifest.origin, 'md');
  assert.equal(read(await toVaultFile(stored, 'Trip.md')), source);
});

test('a plain text file keeps its lines', async () => {
  const source = 'first line\nsecond line\n\nthird after a blank\n';
  const stored = await fromVaultFile(text(source), 'todo.txt');
  assert.equal(read(await toVaultFile(stored, 'todo.txt')), source);
});

test('a Word file is kept byte for byte both ways', async () => {
  const docx = await (await WordDocument.create()).write();
  assert.equal(await fromVaultFile(docx, 'Report.docx'), docx);
  assert.equal(await toVaultFile(docx, 'Report.docx'), docx, 'plain Word bytes');
});

test('a stored document becomes a file in the format its name asks for', async () => {
  const stored = await fromVaultFile(text('# Heading\n\nBody text.\n'), 'a.md');
  const html = read(await toVaultFile(stored, 'a.html'));
  assert.match(html, /<h1[^>]*>Heading<\/h1>/);
  assert.match(html, /Body text\./);
});

test('what the vault does not keep is never converted', async () => {
  assert.equal(await toVaultFile(text('PK'), 'a.zip'), null);
  await assert.rejects(fromVaultFile(text('x'), 'a.zip'));
});

test('a document the account holds in any form the app opens goes out, not just .wdoc and Word', async () => {
  for (const [name, source] of [['Meeting.md', '# Board meeting\n\n- minutes\n'], ['todo.txt', 'milk\n'], ['a.csv', 'a,b\n1,2\n'], ['page.html', '<p>Hi</p>']]) {
    assert.equal(read(await toVaultFile(text(source), name)), source, name);
  }
});

// --- Every other format ------------------------------------------------------------------------------------------------

const FONT_DIR = path.resolve(import.meta.dirname, '../public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const needsFonts = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
/** The app's fonts from the folder they are served from, counting what is asked of them. */
function diskFonts() {
  const asked = { fonts: 0, files: [] as string[] };
  const fonts: VaultFonts = {
    async fonts() {
      asked.fonts++;
      return FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8')), async (p) => new Uint8Array(readFileSync(path.join(FONT_DIR, p))));
    },
    async file(p) {
      asked.files.push(p);
      return new Uint8Array(readFileSync(path.join(FONT_DIR, p)));
    },
  };
  return { fonts, asked };
}
/** Fonts that must not be needed. */
const NO_FONTS: VaultFonts = { fonts: () => Promise.reject(new Error('no fonts needed here')), file: () => Promise.reject(new Error('no fonts needed here')) };
/** Fonts handed to a writer that may draw text, but must not have to: a picture's or a drawing's own page has none. */
const UNUSED_FONTS: VaultFonts = { fonts: async () => ({}) as FontSet, file: () => Promise.reject(new Error('no fonts needed here')) };

const stored = (manifest: { lens: Parameters<typeof writeWdoc>[0]['manifest']['lens']; pagesCurrent?: boolean }, parts: { document?: Uint8Array | null; original?: Uint8Array | null; extensions?: Extensions }) =>
  writeWdoc({ manifest: { version: WDOC_VERSION, lens: manifest.lens, origin: manifest.lens, pagesCurrent: manifest.pagesCurrent ?? false }, document: parts.document ?? null, original: parts.original ?? null, extensions: parts.extensions ?? {} });

test('EPUB and MHTML go out as those files and come back as documents', async () => {
  const doc = await fromVaultFile(text('# Chapter one\n\nIt was a dark night.\n'), 'a.md');
  for (const name of ['Book.epub', 'Page.mhtml']) {
    const file = await toVaultFile(doc, name, NO_FONTS);
    assert.ok(file && file.length, name);
    if (name.endsWith('.epub')) assert.equal(read(file.subarray(0, 2)), 'PK', 'an EPUB is a ZIP');
    else assert.match(read(file), /MIME-Version/i);
    const back = await fromVaultFile(file, name);
    assert.equal((await readWdoc(back)).manifest.lens, name.endsWith('.epub') ? 'epub' : 'mhtml');
    assert.match(read(await toVaultFile(back, 'a.md', NO_FONTS)), /Chapter one[\s\S]*dark night/, name);
  }
});

// --- PDFs

async function samplePdf(): Promise<Uint8Array> {
  const doc = PdfDocument.create();
  const page = doc.addPage([400, 300]);
  const d = new PageDrawing(page, { origin: 'top-left' });
  d.text('First line of text', 40, 50, { font: doc.standardFont('Courier'), size: 12 });
  d.finish();
  return doc.save();
}
const pdfText = (bytes: Uint8Array) => PdfDocument.load(bytes).pages[0].extractText().text;

test('a PDF goes out as its original when nothing was done to it, with no fonts and no reflowing', async () => {
  const pdf = await samplePdf();
  assert.equal(await toVaultFile(pdf, 'Scan.pdf', NO_FONTS), pdf, 'as uploaded');
  const kept = await fromVaultFile(pdf, 'Scan.pdf');
  const wdoc = await readWdoc(kept);
  assert.equal(wdoc.manifest.lens, 'pdf');
  assert.equal(wdoc.document, null, 'not reflowed');
  assert.deepEqual(wdoc.original, pdf);
  assert.deepEqual(await toVaultFile(kept, 'Scan.pdf', NO_FONTS), pdf);
});

test('a PDF goes out with its annotations and form fields written in, still without fonts', async () => {
  const pdf = await samplePdf();
  const annotations = [{ id: 'n1', page: 0, kind: 'note' as const, rect: [10, 10, 30, 30] as [number, number, number, number], quads: [], color: [1, 0.8, 0] as [number, number, number], contents: 'Check this' }];
  const file = (await toVaultFile(await stored({ lens: 'pdf', pagesCurrent: true }, { original: pdf, extensions: { pdf: { annotations } } }), 'Scan.pdf', NO_FONTS))!;
  assert.notDeepEqual(file, pdf);
  const { readAnnotations } = await import('../../pdf/src/index.ts');
  assert.deepEqual(readAnnotations(PdfDocument.load(file)).map((a) => a.contents), ['Check this']);
});

test("a PDF's edits are written into the file, in the font they set text in", needsFonts, async () => {
  const pdf = await samplePdf();
  const edits: PdfEdit[] = [{ id: 'b', page: 0, kind: 'textbox', box: [40, 200, 360, 230], text: 'Added by hand', font: 'Arial', size: 14, color: [0, 0, 0] }];
  const { fonts, asked } = diskFonts();
  const file = (await toVaultFile(await stored({ lens: 'pdf', pagesCurrent: true }, { original: pdf, extensions: { pdf: { annotations: [], edits } } }), 'Scan.pdf', fonts))!;
  const shown = pdfText(file);
  assert.ok(shown.includes('Added by hand') && shown.includes('First line of text'), shown);
  assert.equal(asked.fonts, 1);
  assert.equal(asked.files.length, 1, 'the one font file the edit uses');
});

test('a changed PDF comes back as the new original, with what was done to the old one cleared', async () => {
  const changed = await samplePdf();
  const wdoc = await readWdoc(await fromVaultFile(changed, 'Scan.pdf'));
  assert.deepEqual(wdoc.extensions, {});
  assert.equal(wdoc.manifest.pagesCurrent, true);
  assert.deepEqual(wdoc.original, changed);
});

test('a PDF not reflowed yet goes out as text when its name asks for a text format', async () => {
  const kept = await stored({ lens: 'pdf', pagesCurrent: true }, { original: await samplePdf() });
  assert.match(read(await toVaultFile(kept, 'Scan.md', NO_FONTS)), /First line of text/);
});

test('a PDF whose text was edited goes out laid out from the text, as Download gives it', needsFonts, async () => {
  const document = await WordDocument.create();
  document.body.push({ kind: 'paragraph', properties: {}, children: [{ kind: 'run', properties: {}, content: [{ kind: 'text', text: 'Rewritten text' }] }] } as never);
  const kept = await stored({ lens: 'pdf', pagesCurrent: false }, { original: await samplePdf(), document: await document.write() });
  const file = (await toVaultFile(kept, 'Scan.pdf', diskFonts().fonts))!;
  assert.equal(read(file.subarray(0, 5)), '%PDF-');
  assert.match(pdfText(file), /Rewritten text/);
});

// --- Pictures and drawings (drawn with a recording stand-in for the canvas)

/** A real 1x1 PNG. */
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
let canvas: ReturnType<typeof installFakeCanvas>;
before(() => {
  canvas = installFakeCanvas(() => ({ width: 1, height: 1 }));
});
after(() => canvas.restore());

test('a picture goes out as itself, and comes back as the picture with no layers', async () => {
  assert.equal(await toVaultFile(PNG, 'dot.png', NO_FONTS), PNG, 'as uploaded');
  const kept = await fromVaultFile(PNG, 'dot.png');
  const wdoc = await readWdoc(kept);
  assert.equal(wdoc.manifest.lens, 'png');
  assert.equal(wdoc.extensions.img, undefined);
  // No layers: the picture's own bytes, untouched (no canvas).
  const made = FakeCanvas.made.length;
  assert.deepEqual(await toVaultFile(kept, 'dot.png', UNUSED_FONTS), PNG);
  assert.equal(FakeCanvas.made.length, made);
});

test("a picture's layers are drawn into the file that goes out", async () => {
  const wdoc = await readWdoc(await fromVaultFile(PNG, 'dot.png'));
  const shapes = [{ id: 's1', tool: 'rectangle' as const, color: '#f00', width: 2, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }];
  const layered = await writeWdoc({ ...wdoc, extensions: { img: { shapes } } });
  const made = FakeCanvas.made.length;
  const file = (await toVaultFile(layered, 'dot.png', UNUSED_FONTS))!;
  assert.equal(read(file), 'encoded:image/png', 'drawn and encoded again');
  const drawn = FakeCanvas.made.slice(made);
  assert.ok(drawn.some((c) => c.ctx.ops('drawImage').length && c.ctx.ops('stroke').length + c.ctx.ops('fill').length > 0), 'the picture, then the shape over it');
});

/** Drawings are pictured for the page that shows them: the stand-in canvas encodes a real PNG while they are. */
async function withPngCanvas<T>(run: () => Promise<T>): Promise<T> {
  const saved = FakeCanvas.blob;
  FakeCanvas.blob = (o) => new Blob([PNG], { type: o.type });
  try {
    return await run();
  } finally {
    FakeCanvas.blob = saved;
  }
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect id="r" x="1" y="1" width="5" height="5" fill="#00f"/></svg>';

test('a drawing goes out as its SVG and comes back as the drawing', async () => {
  const kept = await withPngCanvas(() => fromVaultFile(text(SVG), 'd.svg'));
  const wdoc = await readWdoc(kept);
  assert.equal(wdoc.manifest.lens, 'svg');
  assert.equal(read(await toVaultFile(kept, 'd.svg', UNUSED_FONTS)), SVG);
  assert.equal(read(await toVaultFile(text(SVG), 'd.svg', NO_FONTS)), SVG, 'as uploaded');
  const zipped = (await toVaultFile(kept, 'd.svgz', UNUSED_FONTS))!;
  assert.deepEqual([...zipped.subarray(0, 2)], [0x1f, 0x8b], 'gzip');
});

test('a drawing edited together goes out as its objects are now, not as its older SVG', async () => {
  const wdoc = await readWdoc(await withPngCanvas(() => fromVaultFile(text(SVG), 'd.svg')));
  const objects = sceneToObjects(readSvg(SVG.replace('#00f', '#0f0')));
  const together = await writeWdoc({ ...wdoc, extensions: { ...wdoc.extensions, vec: { meta: [objects.meta], nodes: [...objects.nodes], defs: [...objects.defs] } } });
  const out = read(await toVaultFile(together, 'd.svg', UNUSED_FONTS));
  assert.match(out, /#0f0|#00ff00|lime/i);
  assert.doesNotMatch(out, /#00f"/);
});

// --- What the app reads but cannot write

test('a legacy .doc, a GIF and a HEIC go out as uploaded, and as what the app edits them as once it has saved them', async () => {
  const ole = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0);
  assert.equal(await toVaultFile(ole, 'Old.doc', NO_FONTS), ole);
  assert.equal(await fromVaultFile(ole, 'Old.doc'), ole, 'kept as uploaded: the app reads it when it is opened');
  const docx = await (await WordDocument.create()).write();
  const saved = await stored({ lens: 'docx' }, { document: docx });
  assert.deepEqual(await toVaultFile(saved, 'Old.doc', NO_FONTS), docx, 'Word, under the same name');
  const gif = text('GIF89a\x01\x00\x01\x00');
  assert.equal(await toVaultFile(gif, 'a.gif', NO_FONTS), gif);
  assert.equal(await fromVaultFile(gif, 'a.gif'), gif);
  const picture = await fromVaultFile(PNG, 'a.png');
  assert.deepEqual(await toVaultFile(picture, 'a.gif', UNUSED_FONTS), PNG, 'saved: a PNG');
  assert.equal(read(await toVaultFile(picture, 'a.heic', UNUSED_FONTS)), 'encoded:image/jpeg', 'saved: a JPEG, as a .jpg is');
});
