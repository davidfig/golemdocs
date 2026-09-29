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
