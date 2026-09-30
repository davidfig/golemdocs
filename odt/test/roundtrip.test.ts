import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteText, insertText, paragraphsIn, paragraphText, WordDocument, ZipArchive, type Paragraph } from '@word/docx';
import { readOdt, writeOdt, type OdtExtension } from '../src/index.ts';
import { libreOfficeFixture } from './fixtures.ts';
import { find, textOf, validateOdt } from './validate.ts';

async function parts(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = ZipArchive.read(bytes);
  const out = new Map<string, Uint8Array>();
  for (const [name, entry] of zip.entries) out.set(name, await entry.read());
  return out;
}

test('an ODT the app wrote round-trips byte for byte', async () => {
  const first = await readOdt(await libreOfficeFixture());
  const b1 = await writeOdt(first.document, first.extension);
  const second = await readOdt(b1);
  const b2 = await writeOdt(second.document, second.extension);
  const third = await readOdt(b2);
  const b3 = await writeOdt(third.document, third.extension);
  assert.deepEqual(await parts(b2), await parts(b1));
  assert.deepEqual(b3, b2);
  // Paragraph ids and the extension are stable too.
  const ids = (d: WordDocument) => paragraphsIn(d.body).map((p) => p.attrs['w14:paraId']);
  assert.deepEqual(ids(second.document), ids(first.document));
  assert.deepEqual(second.document.comments, first.document.comments);
  assert.deepEqual(third.extension, second.extension);
});

test('a Word document written twice gives the same bytes', async () => {
  const doc = await WordDocument.create();
  (doc.body[0] as Paragraph).children.push({ kind: 'run', properties: { italic: true }, content: [{ kind: 'text', text: 'Hi  there' }], attrs: {} });
  const a = await writeOdt(doc);
  const b = await writeOdt(doc);
  assert.deepEqual(a, b);
  const again = await readOdt(a);
  assert.deepEqual(await parts(await writeOdt(again.document, again.extension)), await parts(await writeOdt((await readOdt(await writeOdt(again.document, again.extension))).document, again.extension)));
});

test('the extension survives a trip through .docx (another format and back)', async () => {
  const { document, extension } = await readOdt(await libreOfficeFixture());
  // What the app does when switching format: the core goes through the model's own
  // serialisation; the extension is kept as JSON beside it.
  const docx = await WordDocument.read(await document.write());
  const json: OdtExtension = JSON.parse(JSON.stringify(extension));
  const { content, styles } = await validateOdt(await writeOdt(docx, json));
  assert.equal(find(content, 'office:annotation').length, 1);
  assert.equal(textOf(find(content, 'office:annotation')[0]).includes('A comment'), true);
  assert.equal(find(content, 'text:bookmark-start').length, 1);
  assert.equal(find(content, 'text:date').length, 1);
  assert.equal(find(content, 'text:section').length, 1);
  assert.equal(find(content, 'text:note').length, 1);
  assert.equal(find(styles, 'text:notes-configuration').length, 1);
  const frame = find(content, 'draw:frame').find((f) => f.attrs['draw:name'] === 'Picture 1')!;
  assert.equal(frame.attrs['text:anchor-type'], 'char', 'the picture keeps its anchoring');
});

test('extension content whose anchors are gone is skipped; edited anchors degrade', async () => {
  const { document, extension } = await readOdt(await libreOfficeFixture());
  const paragraphs = paragraphsIn(document.body);
  const byText = (start: string) => paragraphs.find((p) => paragraphText(p).startsWith(start))!;

  // Remove the paragraph with the comment and bookmark.
  const commented = byText('Small sans');
  document.body.splice(document.body.indexOf(commented), 1);
  // Change the text a field displays: the field can't come back, its text stays.
  const dated = byText('Dated');
  deleteText(dated, 6, 16);
  insertText(dated, 6, 'yesterday!'); // same length, so the next field's offset still holds
  // Remove the section's last paragraph: the section can't be placed.
  const last = byText('Footnote');
  document.body.splice(document.body.indexOf(last), 1);

  const { content } = await validateOdt(await writeOdt(document, extension));
  assert.equal(find(content, 'office:annotation').length, 0);
  assert.equal(find(content, 'text:bookmark-start').length + find(content, 'text:bookmark').length, 0);
  assert.equal(find(content, 'text:date').length, 0);
  assert.equal(find(content, 'text:author-name').length, 1, 'the other field is untouched');
  assert.ok(find(content, 'text:p').some((p) => textOf(p).startsWith('Dated yesterday! by Ada')));
  assert.equal(find(content, 'text:section').length, 0);
  assert.equal(find(content, 'text:note').length, 0);
});

test('offsets past the end are skipped', async () => {
  const { document, extension } = await readOdt(await libreOfficeFixture());
  const p = paragraphsIn(document.body).find((q) => paragraphText(q).startsWith('Small sans'))!;
  const id = p.attrs['w14:paraId'];
  const ext: OdtExtension = JSON.parse(JSON.stringify(extension));
  ext.bookmarks![0].end!.offset = 2; // before its start
  ext.bookmarks!.push({ name: 'Far', paragraphId: id, offset: 10_000 });
  const { content } = await validateOdt(await writeOdt(document, ext));
  assert.equal(find(content, 'text:bookmark').length, 1);
  assert.equal(find(content, 'text:bookmark')[0].attrs['text:name'], 'Target');
});

test('comments move with their paragraph', async () => {
  const { document, extension } = await readOdt(await libreOfficeFixture());
  // The paragraph moves to the end of the document: its markers go with it.
  const p = paragraphsIn(document.body).find((q) => paragraphText(q).startsWith('Small sans'))!;
  document.body.splice(document.body.indexOf(p), 1);
  document.body.push(p);
  const { content } = await validateOdt(await writeOdt(document, extension));
  const target = find(content, 'text:p').find((e) => e.attrs['xml:id'] === `para-${p.attrs['w14:paraId']}`)!;
  const names = target.children.filter((c) => typeof c !== 'string').map((c) => (c as { name: string }).name);
  assert.deepEqual(names.filter((n) => !n.startsWith('text:span')), ['office:annotation', 'office:annotation-end', 'text:bookmark-start', 'text:bookmark-end']);
});
