import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentRanges, insertText, paragraphsIn, paragraphText, WordDocument } from '@golemdocs/docx';
import { readOdt, writeOdt } from '../src/index.ts';
import { minimalContent, odtPackage } from './fixtures.ts';
import { find, textOf, validateOdt } from './validate.ts';

const body = `
<text:p>Hello <office:annotation office:name="a1" loext:resolved="true"><dc:creator>Ada</dc:creator><dc:date>2024-05-01T10:00:00</dc:date><loext:sender-initials>A</loext:sender-initials><text:p>Top<text:s text:c="2"/>level</text:p><text:p>Second</text:p></office:annotation><office:annotation office:name="a2" loext:parent-name="a1"><dc:creator>Bob</dc:creator><dc:date>2024-05-02T10:00:00</dc:date><text:p>A reply</text:p></office:annotation>big world<office:annotation-end office:name="a1"/> there<office:annotation office:name="p1"><dc:creator>Cy</dc:creator><text:p>Point</text:p></office:annotation>.</text:p>`;

async function commented() {
  return readOdt(await odtPackage({ content: minimalContent(body) }));
}

const paragraph = (d: WordDocument) => paragraphsIn(d.body).find((p) => paragraphText(p).startsWith('Hello'))!;

test('annotations become model comments with threading, resolved and markers', async () => {
  const { document } = await commented();
  assert.deepEqual(document.comments.map((c) => [c.id, c.author, c.parentId, c.resolved]), [
    ['0', 'Ada', undefined, true],
    ['1', 'Bob', '0', undefined],
    ['2', 'Cy', undefined, undefined],
  ]);
  assert.deepEqual(document.comments[0].paragraphs, ['Top  level', 'Second']);
  assert.equal(document.comments[0].initials, 'A');
  const ranges = commentRanges([paragraph(document)]);
  const [parent, reply] = [ranges.get('0')!, ranges.get('1')!];
  assert.ok(parent.end.offset > parent.start.offset);
  // The reply's markers sit next to its parent's (each marker is one position).
  assert.equal(reply.start.offset, parent.start.offset + 1);
  assert.equal(reply.end.offset, parent.end.offset + 2);
  assert.equal(ranges.get('2')!.start.offset, ranges.get('2')!.end.offset, 'a point comment is an empty range');
});

test('comments are written back as annotations, with threading and resolved', async () => {
  const { document, extension } = await commented();
  const { content } = await validateOdt(await writeOdt(document, extension));
  const notes = find(content, 'office:annotation');
  assert.equal(notes.length, 3);
  assert.equal(notes[0].attrs['loext:resolved'], 'true');
  assert.equal(notes[1].attrs['loext:parent-name'], notes[0].attrs['office:name']);
  assert.equal(find(content, 'office:annotation-end').length, 2, 'the reply has no range of its own');
  assert.equal(find(notes[0], 'text:s')[0].attrs['text:c'], '1');
  const again = await readOdt(await writeOdt(document, extension));
  assert.deepEqual(again.document.comments, document.comments);
  assert.deepEqual(
    [...commentRanges(paragraphsIn(again.document.body)).values()].map((r) => [r.id, r.start.offset, r.end.offset]).slice(0, 1),
    [...commentRanges(paragraphsIn(document.body)).values()].map((r) => [r.id, r.start.offset, r.end.offset]).slice(0, 1),
  );
});

test('editing text before a comment keeps it on the same text', async () => {
  const { document, extension } = await commented();
  insertText(paragraph(document), 0, 'Well, ');
  const { content } = await validateOdt(await writeOdt(document, extension));
  const p = find(content, 'text:p').find((e) => textOf(e).startsWith('Well, Hello'))!;
  const flat = p.children.map((c) => (typeof c === 'string' ? c : c.name === 'office:annotation' ? '[' : c.name === 'office:annotation-end' ? ']' : c.name === 'text:span' ? textOf(c) : '')).join('');
  assert.match(flat, /^Well, Hello \[\[big world\] there\[/);
});

test('comments survive ODT -> DOCX -> ODT', async () => {
  const { document, extension } = await commented();
  const docx = await WordDocument.read(await document.write());
  assert.deepEqual(docx.comments.map((c) => [c.author, c.parentId, c.resolved]), document.comments.map((c) => [c.author, c.parentId, c.resolved]));
  const { content } = await validateOdt(await writeOdt(docx, JSON.parse(JSON.stringify(extension))));
  const notes = find(content, 'office:annotation');
  assert.equal(notes.length, 3);
  assert.equal(notes[0].attrs['loext:resolved'], 'true');
  assert.equal(notes[1].attrs['loext:parent-name'], notes[0].attrs['office:name']);
  assert.equal(find(content, 'office:annotation-end').length, 2);
});

test('a comment without markers is not written', async () => {
  const { document, extension } = await commented();
  document.comments.push({ id: '99', author: 'Nobody', paragraphs: ['orphan'] });
  const { content } = await validateOdt(await writeOdt(document, extension));
  assert.equal(find(content, 'office:annotation').length, 3);
});
