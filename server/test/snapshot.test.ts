import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphsIn, sha256Hex, sharedMediaPart, WordDocument, writeZip, ZipArchive } from '@golemdocs/docx';
import { Engine, objectTransaction } from '@golemdocs/ops';
import { applyLog } from '../src/snapshot.ts';

test('applying a log to a document gives the same text as the clients would see', async () => {
  const doc = await WordDocument.create();
  doc.body = [{ kind: 'paragraph', properties: {}, children: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text: 'Hello' }] }], attrs: {} }];
  const base = await doc.write();

  const loaded = await WordDocument.read(base);
  const id = new Engine(loaded).index.id(paragraphsIn(loaded.body)[0]);
  const out = await applyLog(base, [
    { id: 'a:0', client: 'a', ops: [{ type: 'insertText', paragraph: id, offset: 5, text: ' world' }] },
    { id: 'b:0', client: 'b', ops: [{ type: 'insertText', paragraph: id, offset: 0, text: '>> ' }] },
  ]);

  const result = await WordDocument.read(out);
  const text = paragraphsIn(result.body)
    .map((p) => JSON.stringify(p.children))
    .join('');
  assert.match(text, /Hello/);
  assert.match(text, /world/);
  assert.match(text, /&gt;&gt;|>> /);
});

test('a transaction that cannot be applied is left out, so the rest still are', async () => {
  const doc = await WordDocument.create();
  doc.body = [{ kind: 'paragraph', properties: {}, children: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text: 'Hello' }] }], attrs: {} }];
  const base = await doc.write();
  const loaded = await WordDocument.read(base);
  const id = new Engine(loaded).index.id(paragraphsIn(loaded.body)[0]);
  const out = await applyLog(base, [
    { id: 'a:0', client: 'a', ops: [{ type: 'insertItem', paragraph: id, offset: 0, item: null as never }] },
    { id: 'b:0', client: 'b', ops: [{ type: 'insertText', paragraph: id, offset: 5, text: ' world' }] },
  ]);
  assert.match(JSON.stringify((await WordDocument.read(out)).body), /world/);
});

test('a log applied to a stored .wdoc changes its document and keeps the format and extensions beside it', async () => {
  const doc = await WordDocument.create();
  doc.body = [{ kind: 'paragraph', properties: {}, children: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text: 'Hello' }] }], attrs: {} }];
  const docx = await doc.write();
  const encoder = new TextEncoder();
  const manifest = { version: 1, lens: 'md', origin: 'md', pagesCurrent: false };
  const extension = { frontMatter: 'title: Notes' };
  const wdoc = await writeZip([
    { name: 'mimetype', data: encoder.encode('application/x-golem-document'), compress: false },
    { name: 'manifest.json', data: encoder.encode(JSON.stringify(manifest)) },
    { name: 'document.docx', data: docx, compress: false },
    { name: 'extensions/md.json', data: encoder.encode(JSON.stringify(extension)) },
  ]);
  const loaded = await WordDocument.read(docx);
  const id = new Engine(loaded).index.id(paragraphsIn(loaded.body)[0]);
  const out = await applyLog(wdoc, [{ id: 'a:0', client: 'a', ops: [{ type: 'insertText', paragraph: id, offset: 5, text: ' world' }] }]);

  const zip = ZipArchive.read(out);
  assert.deepEqual([...zip.entries.keys()], ['mimetype', 'manifest.json', 'document.docx', 'extensions/md.json'], 'the same entries in the same order');
  assert.equal(await zip.entries.get('mimetype')!.text(), 'application/x-golem-document');
  assert.deepEqual(JSON.parse(await zip.entries.get('manifest.json')!.text()), manifest);
  assert.deepEqual(JSON.parse(await zip.entries.get('extensions/md.json')!.text()), extension);
  assert.match(JSON.stringify((await WordDocument.read(await zip.entries.get('document.docx')!.read())).body), /world/);
});

test('a .wdoc with no document in it is left as it is', async () => {
  const encoder = new TextEncoder();
  const wdoc = await writeZip([{ name: 'mimetype', data: encoder.encode('application/x-golem-document'), compress: false }, { name: 'manifest.json', data: encoder.encode('{}') }]);
  const out = await applyLog(wdoc, [{ id: 'a:0', client: 'a', ops: [] }]);
  assert.deepEqual(out, wdoc);
});

test('a picture added while editing together is written into the document the snapshot makes', async () => {
  const doc = await WordDocument.create();
  doc.body = [{ kind: 'paragraph', properties: {}, children: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text: 'Hello' }] }], attrs: {} }];
  const base = await doc.write();
  const loaded = await WordDocument.read(base);
  const id = new Engine(loaded).index.id(paragraphsIn(loaded.body)[0]);
  const picture = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const hash = await sha256Hex(picture);
  const part = sharedMediaPart(hash, 'png');
  const insert = { id: 'a:0', client: 'a', ops: [{ type: 'insertContent' as const, paragraph: id, offset: 5, content: [{ kind: 'run' as const, properties: {}, attrs: {}, content: [{ kind: 'drawing' as const, inline: true, width: 100, height: 100, image: part }] }] }] };

  const asked: string[] = [];
  const out = await applyLog(base, [insert], async (wanted) => (asked.push(wanted), wanted === hash ? picture : null));
  assert.deepEqual(asked, [hash]);
  const result = await WordDocument.read(out);
  assert.deepEqual(await result.media(part), picture, 'the picture is in the document');
  assert.deepEqual(result.missingMedia(), [], 'and nothing the document refers to is missing');
});

test('a picture that was never uploaded leaves the rest of the log applied', async () => {
  const doc = await WordDocument.create();
  doc.body = [{ kind: 'paragraph', properties: {}, children: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text: 'Hello' }] }], attrs: {} }];
  const base = await doc.write();
  const loaded = await WordDocument.read(base);
  const id = new Engine(loaded).index.id(paragraphsIn(loaded.body)[0]);
  const part = sharedMediaPart('a'.repeat(64), 'png');
  const out = await applyLog(base, [
    { id: 'a:0', client: 'a', ops: [{ type: 'insertContent', paragraph: id, offset: 5, content: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'drawing', inline: true, width: 1, height: 1, image: part }] }] }] },
    { id: 'b:0', client: 'b', ops: [{ type: 'insertText', paragraph: id, offset: 0, text: 'x' }] },
  ], async () => null);
  assert.match(JSON.stringify((await WordDocument.read(out)).body), /xHello/);
});

// --- A PDF's objects ------------------------------------------------------------------------------------------------------

async function pdfWdoc(extension: object | null) {
  const encoder = new TextEncoder();
  const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4]);
  return {
    pdf,
    bytes: await writeZip([
      { name: 'mimetype', data: encoder.encode('application/x-golem-document'), compress: false },
      { name: 'manifest.json', data: encoder.encode(JSON.stringify({ version: 1, lens: 'pdf', origin: 'pdf', pagesCurrent: true })) },
      ...(extension ? [{ name: 'extensions/pdf.json', data: encoder.encode(JSON.stringify(extension)) }] : []),
      { name: 'originals/source.pdf', data: pdf, compress: false },
    ]),
  };
}
const note = (id: string, contents = '') => ({ id, page: 0, kind: 'note', contents });
const put = (layer: 'annotations' | 'fields' | 'edits', value: { id: string }) => ({ type: 'put' as const, layer, id: value.id, value });

test('changes to a PDF’s objects are written into its extension, and the PDF itself is copied as it was', async () => {
  const { bytes, pdf } = await pdfWdoc({ annotations: [note('a', 'one'), note('b')], fields: [{ id: 'f', value: 'x' }] });
  const out = await applyLog(
    bytes,
    [
      objectTransaction('a:0', 'a', [put('annotations', note('a', 'changed')), put('annotations', note('c'))]),
      objectTransaction('b:0', 'b', [{ type: 'del', layer: 'annotations', id: 'b' }, put('edits', { id: 'e1' })]),
    ],
    undefined,
    'objects',
  );
  const zip = ZipArchive.read(out);
  assert.deepEqual([...zip.entries.keys()], ['mimetype', 'manifest.json', 'extensions/pdf.json', 'originals/source.pdf']);
  assert.deepEqual(await zip.entries.get('originals/source.pdf')!.read(), pdf, 'the PDF is as it was');
  const extension = JSON.parse(await zip.entries.get('extensions/pdf.json')!.text());
  assert.deepEqual(extension.annotations, [note('a', 'changed'), note('c')]);
  assert.deepEqual(extension.fields, [{ id: 'f', value: 'x' }], 'a list nothing touched is as it was');
  assert.deepEqual(extension.edits, [{ id: 'e1' }], 'a list that had none gets one once something is put in it');
});

test('a list the file never had stays missing (it means "as in the PDF"), and a file with no extension gets one', async () => {
  const { bytes } = await pdfWdoc({ annotations: [note('a')] });
  const out = await applyLog(bytes, [objectTransaction('a:0', 'a', [put('annotations', note('b'))])], undefined, 'objects');
  const extension = JSON.parse(await ZipArchive.read(out).entries.get('extensions/pdf.json')!.text());
  assert.equal('fields' in extension, false);
  assert.equal('edits' in extension, false);

  const bare = await pdfWdoc(null);
  const made = await applyLog(bare.bytes, [objectTransaction('a:0', 'a', [put('annotations', note('n'))])], undefined, 'objects');
  assert.deepEqual(JSON.parse(await ZipArchive.read(made).entries.get('extensions/pdf.json')!.text()), { annotations: [note('n')] });
});

test('a change to a PDF that cannot be applied leaves the file as it was', async () => {
  const garbage = Uint8Array.from([1, 2, 3]);
  const out = await applyLog(garbage, [objectTransaction('a:0', 'a', [put('annotations', note('n'))])], undefined, 'objects');
  assert.deepEqual(out, garbage);
});

test('a picture’s shapes are written into its extension, and the picture itself is copied as it was', async () => {
  const encoder = new TextEncoder();
  const picture = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
  const base = await writeZip([
    { name: 'mimetype', data: encoder.encode('application/x-golem-document'), compress: false },
    { name: 'manifest.json', data: encoder.encode(JSON.stringify({ version: 1, lens: 'png', origin: 'png', pagesCurrent: false })) },
    { name: 'document.docx', data: picture, compress: false },
    { name: 'extensions/img.json', data: encoder.encode(JSON.stringify({ shapes: [{ id: 'a', tool: 'pen' }, { id: 'b', tool: 'line' }] })) },
  ]);
  const out = await applyLog(
    base,
    [objectTransaction('x:0', 'x', [put('shapes', { id: 'c' }), { type: 'del', layer: 'shapes', id: 'a' }]), objectTransaction('y:0', 'y', [put('annotations', { id: 'stray' })])],
    undefined,
    'layers',
  );
  const zip = ZipArchive.read(out);
  assert.deepEqual(await zip.entries.get('document.docx')!.read(), picture);
  assert.deepEqual(JSON.parse(await zip.entries.get('extensions/img.json')!.text()).shapes, [{ id: 'b', tool: 'line' }, { id: 'c' }]);
  assert.equal('annotations' in JSON.parse(await zip.entries.get('extensions/img.json')!.text()), false, 'a list a picture does not have is not made');
});
