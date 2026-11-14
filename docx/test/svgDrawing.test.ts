import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument, type Drawing, type Paragraph } from '../src/index.ts';

const PNG_1X1 = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');

const drawingsOf = (doc: WordDocument): Drawing[] =>
  (doc.body as Paragraph[]).flatMap((p) => p.children.flatMap((c) => (c.kind === 'run' ? c.content.filter((i): i is Drawing => i.kind === 'drawing') : [])));

test('a drawing keeps the SVG beside its picture through a save and a read', async () => {
  const doc = await WordDocument.create();
  const image = doc.addImage(PNG_1X1, 'png');
  const svg = doc.addImage(SVG, 'svg');
  doc.body = [{ kind: 'paragraph', properties: {}, attrs: {}, children: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'drawing', inline: true, width: 914400, height: 914400, image, svg }] }] }];
  const once = await WordDocument.read(await doc.write());
  const [drawing] = drawingsOf(once);
  assert.equal(drawing.image, image);
  assert.equal(drawing.svg, svg);
  assert.equal(new TextDecoder().decode(await once.media(drawing.svg!)), new TextDecoder().decode(SVG));
  // And again: the sidecar is not written twice.
  const twice = await WordDocument.read(await once.write());
  assert.equal(drawingsOf(twice)[0].svg, svg);
});

test('a picture with no SVG beside it has none', async () => {
  const doc = await WordDocument.create();
  const image = doc.addImage(PNG_1X1, 'png');
  doc.body = [{ kind: 'paragraph', properties: {}, attrs: {}, children: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'drawing', inline: true, width: 914400, height: 914400, image }] }] }];
  const read = await WordDocument.read(await doc.write());
  assert.equal(drawingsOf(read)[0].svg, undefined);
});

test('changing a drawing to another SVG part points the file at the new one', async () => {
  const doc = await WordDocument.create();
  const image = doc.addImage(PNG_1X1, 'png');
  const first = doc.addImage(SVG, 'svg');
  const run = { kind: 'run' as const, properties: {}, attrs: {}, content: [{ kind: 'drawing' as const, inline: true, width: 914400, height: 914400, image, svg: first }] };
  doc.body = [{ kind: 'paragraph', properties: {}, attrs: {}, children: [run] }];
  const once = await WordDocument.read(await doc.write());
  const second = once.addImage(SVG, 'svg');
  drawingsOf(once)[0].svg = second;
  const twice = await WordDocument.read(await once.write());
  assert.equal(drawingsOf(twice)[0].svg, second);
});

test('pictures nothing shows any more are left out of the file, and come back with what shows them', async () => {
  const doc = await WordDocument.create();
  const drawingRun = (image: string, svg?: string) => ({ kind: 'run' as const, properties: {}, attrs: {}, content: [{ kind: 'drawing' as const, inline: true, width: 914400, height: 914400, image, ...(svg && { svg }) }] });
  const old = drawingRun(doc.addImage(PNG_1X1, 'png'), doc.addImage(SVG, 'svg'));
  doc.body = [{ kind: 'paragraph', properties: {}, attrs: {}, children: [old] }];
  const read = await WordDocument.read(await doc.write());
  // Replaced over and over, as a live picture is on each update: the file holds only the last picture.
  for (let i = 0; i < 4; i++) {
    (read.body[0] as Paragraph).children = [drawingRun(read.addImage(PNG_1X1, 'png'), read.addImage(SVG, 'svg'))];
    await read.write();
  }
  const last = await WordDocument.read(await read.write());
  const media = last.pkg.partNames.filter((n) => n.startsWith('word/media/'));
  const [drawing] = drawingsOf(last);
  assert.deepEqual(media.sort(), [drawing.image, drawing.svg].sort());
  const rels = await last.pkg.relationships(last.mainPart);
  assert.equal(rels.list.filter((r) => /\/image$/.test(r.type)).length, 2);
  // An undo that brings the first picture back finds its parts still there.
  (read.body[0] as Paragraph).children = [old];
  const undone = await WordDocument.read(await read.write());
  const [back] = drawingsOf(undone);
  assert.equal(back.image, old.content[0].image);
  assert.deepEqual(await undone.media(back.image!), PNG_1X1);
  assert.ok(undone.pkg.has(back.svg!));
});

test('a picture another part uses (footnotes, say) is kept', async () => {
  const doc = await WordDocument.create();
  const image = doc.addImage(PNG_1X1, 'png');
  doc.pkg.set('word/footnotes.xml', '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>');
  (await doc.pkg.relationships('word/footnotes.xml')).add('http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', image);
  const read = await WordDocument.read(await doc.write());
  assert.ok(read.pkg.has(image));
});
