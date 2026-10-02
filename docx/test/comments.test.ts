import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZipArchive, commentEnd, commentMarkerOffsets, commentRanges, commentReference, commentStart, WordDocument, type Paragraph } from '../src/index.ts';

const text = (t: string) => ({ kind: 'run' as const, properties: {}, content: [{ kind: 'text' as const, text: t }], attrs: {} });

async function commented(): Promise<WordDocument> {
  const doc = await WordDocument.create();
  const p: Paragraph = { kind: 'paragraph', properties: {}, children: [text('Hello '), commentStart('0'), text('big'), commentEnd('0'), commentReference('0'), text(' world')], attrs: {} };
  doc.body = [p];
  doc.comments = [{ id: '0', author: 'Ada', initials: 'AL', date: '2026-01-02T03:04:05Z', paragraphs: ['Is this right?', 'Second line'] }];
  return doc;
}

test('comments are written to the comments part and read back', async () => {
  const back = await WordDocument.read(await (await commented()).write());
  assert.deepEqual(back.comments, [{ id: '0', author: 'Ada', initials: 'AL', date: '2026-01-02T03:04:05Z', paragraphs: ['Is this right?', 'Second line'] }]);
  const zip = ZipArchive.read(await back.write());
  assert.ok(zip.entries.has('word/comments.xml'));
  assert.match(await zip.entries.get('[Content_Types].xml')!.text(), /wordprocessingml\.comments\+xml/);
});

test('a comment range covers the text between its markers', async () => {
  const doc = await commented();
  const range = commentRanges(doc.body as Paragraph[]).get('0')!;
  // "Hello " is 6 positions, the start marker the 7th: the range is "big".
  assert.equal(range.start.offset, 7);
  assert.equal(range.end.offset, 10);
  // Markers at 6 (start), 10 (end), 11 (reference), highest first.
  assert.deepEqual(commentMarkerOffsets(doc.body[0] as Paragraph, '0'), [11, 10, 6]);
});

test('unchanged comments keep their original XML; changed ones are rewritten', async () => {
  // A comment with formatting Word wrote, which our model doesn't hold.
  const doc = await WordDocument.read(await (await commented()).write());
  const zip = ZipArchive.read(await doc.write());
  const xml = await zip.entries.get('word/comments.xml')!.text();
  const rich = xml.replace('<w:t xml:space="preserve">Is this right?</w:t>', '<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Is this right?</w:t>');
  const { writeZip } = await import('../src/index.ts');
  const entries = [...zip.entries.values()].map((e) => (e.name === 'word/comments.xml' ? { name: e.name, data: new TextEncoder().encode(rich) } : { name: e.name, entry: e }));
  const withBold = await WordDocument.read(await writeZip(entries));
  const unchanged = await ZipArchive.read(await withBold.write()).entries.get('word/comments.xml')!.text();
  assert.match(unchanged, /<w:b\/>/);
  withBold.comments[0].paragraphs = ['Edited'];
  const changed = await ZipArchive.read(await withBold.write()).entries.get('word/comments.xml')!.text();
  assert.doesNotMatch(changed, /<w:b\/>/);
  assert.match(changed, /Edited/);
});

test('replies and the resolved mark are written to the extended part and read back', async () => {
  const doc = await commented();
  doc.comments.push({ id: '1', author: 'Bo', date: '2026-01-03T00:00:00Z', paragraphs: ['Yes'], parentId: '0' });
  doc.comments[0].resolved = true;
  const bytes = await doc.write();
  const zip = ZipArchive.read(bytes);
  assert.ok(zip.entries.has('word/commentsExtended.xml'));
  assert.match(await zip.entries.get('[Content_Types].xml')!.text(), /commentsExtended\+xml/);
  const back = await WordDocument.read(bytes);
  assert.equal(back.comments[1].parentId, '0');
  assert.equal(back.comments[0].resolved, true);
  assert.equal(back.comments[1].resolved, undefined);
  // Untouched, it writes the same again (ids are stable).
  const again = await WordDocument.read(await back.write());
  assert.deepEqual(again.comments, back.comments);
});

test('a document without threads gets no extended part', async () => {
  const zip = ZipArchive.read(await (await commented()).write());
  assert.equal(zip.entries.has('word/commentsExtended.xml'), false);
});

test('tabs and line breaks in a changed comment are written as Word tabs and breaks', async () => {
  const doc = await commented();
  doc.comments[0].paragraphs = ['a\tb\nc'];
  const bytes = await doc.write();
  const xml = await ZipArchive.read(bytes).entries.get('word/comments.xml')!.text();
  assert.match(xml, /<w:t xml:space="preserve">a<\/w:t><w:tab\/><w:t xml:space="preserve">b<\/w:t><w:br\/><w:t xml:space="preserve">c<\/w:t>/);
  assert.deepEqual((await WordDocument.read(bytes)).comments[0].paragraphs, ['a\tb\nc']);
});

test('a reference inside a run anchors where it is in the run', () => {
  const reference = commentReference('0');
  reference.content.unshift({ kind: 'text', text: 'ab' });
  const p: Paragraph = { kind: 'paragraph', properties: {}, children: [text('xy'), reference], attrs: {} };
  const range = commentRanges([p]).get('0')!;
  assert.equal(range.start.offset, 4);
  assert.deepEqual(commentMarkerOffsets(p, '0'), [4]);
});

test('unchanged comments leave their parts as they were; edits keep the extended part root', async () => {
  const doc = await commented();
  doc.comments.push({ id: '1', author: 'Bo', paragraphs: ['Yes'], parentId: '0' });
  const zip = ZipArchive.read(await doc.write());
  // Word's own attributes, which the writer doesn't produce itself.
  const comments = (await zip.entries.get('word/comments.xml')!.text()).replace('<w:comments ', '<w:comments data-extra="1" ');
  const extended = (await zip.entries.get('word/commentsExtended.xml')!.text()).replace('mc:Ignorable="w15"', 'mc:Ignorable="w14 w15 w16se"');
  const { writeZip } = await import('../src/index.ts');
  const replaced: Record<string, string> = { 'word/comments.xml': comments, 'word/commentsExtended.xml': extended };
  const entries = [...zip.entries.values()].map((e) => (replaced[e.name] ? { name: e.name, data: new TextEncoder().encode(replaced[e.name]) } : { name: e.name, entry: e }));
  const read = await WordDocument.read(await writeZip(entries));
  const same = ZipArchive.read(await read.write());
  assert.equal(await same.entries.get('word/comments.xml')!.text(), comments);
  assert.equal(await same.entries.get('word/commentsExtended.xml')!.text(), extended);
  read.comments[1].paragraphs = ['Edited'];
  const edited = ZipArchive.read(await read.write());
  assert.match(await edited.entries.get('word/commentsExtended.xml')!.text(), /mc:Ignorable="w14 w15 w16se"/);
});
