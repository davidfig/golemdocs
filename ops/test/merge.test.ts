import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphsIn, paragraphText, WordDocument, type Block, type Paragraph } from '@golemdocs/docx';
import { mergeDocuments } from '../src/index.ts';

const run = (text: string, bold = false) => ({ kind: 'run' as const, properties: bold ? { bold: true } : {}, attrs: {}, content: [{ kind: 'text' as const, text }] });
const para = (text: string, properties: Paragraph['properties'] = {}): Paragraph => ({ kind: 'paragraph', properties, children: text ? [run(text)] : [], attrs: {} });
const cell = (text: string) => ({ kind: 'cell' as const, properties: {}, attrs: {}, children: [para(text)] });
const table = (...texts: string[]): Block => ({ kind: 'table', properties: {}, grid: texts.map(() => 3000), rows: [{ kind: 'row', properties: {}, attrs: {}, cells: texts.map(cell) }] });

async function documentOf(blocks: Block[]): Promise<WordDocument> {
  const doc = await WordDocument.create();
  doc.body = structuredClone(blocks);
  return doc;
}

/** Three documents (base, mine, theirs), each made from its own copy of the blocks, as if read from three files. */
const three = (base: Block[], mine: Block[], theirs: Block[]) => Promise.all([documentOf(base), documentOf(mine), documentOf(theirs)]);
const texts = (doc: WordDocument) => paragraphsIn(doc.body).map(paragraphText);

test('changes to different paragraphs are both kept', async () => {
  const [base, mine, theirs] = await three([para('One.'), para('Two.'), para('Three.')], [para('One, edited here.'), para('Two.'), para('Three.')], [para('One.'), para('Two.'), para('Three, edited by the ai.')]);
  const merged = mergeDocuments(base, mine, theirs);
  assert.ok(merged);
  assert.deepEqual(texts(merged), ['One, edited here.', 'Two.', 'Three, edited by the ai.']);
});

test('paragraphs added and removed on both sides, in different places, are all kept', async () => {
  const [base, mine, theirs] = await three(
    [para('A'), para('B'), para('C'), para('D')],
    [para('A'), para('Mine after A'), para('B'), para('C'), para('D')],
    [para('A'), para('B'), para('D'), para('Theirs at the end')],
  );
  const merged = mergeDocuments(base, mine, theirs);
  assert.ok(merged);
  assert.deepEqual(texts(merged), ['A', 'Mine after A', 'B', 'D', 'Theirs at the end']);
  // New paragraphs get ids of their own: none repeats.
  const ids = paragraphsIn(merged.body).map((p) => p.attrs['w14:paraId']);
  assert.equal(new Set(ids).size, ids.length);
});

test('the same paragraph changed on both sides is not merged', async () => {
  const [base, mine, theirs] = await three([para('Hello world.'), para('Other.')], [para('Hello there, world.'), para('Other.')], [para('Hello world!'), para('Other.')]);
  assert.equal(mergeDocuments(base, mine, theirs), null);
});

test('one side removing a paragraph the other changed is not merged', async () => {
  const [base, mine, theirs] = await three([para('Keep.'), para('Contested.'), para('End.')], [para('Keep.'), para('Contested, reworded.'), para('End.')], [para('Keep.'), para('End.')]);
  assert.equal(mergeDocuments(base, mine, theirs), null);
});

test('both sides inserting at the same place is not merged (which goes first is a guess)', async () => {
  const [base, mine, theirs] = await three([para('A'), para('B')], [para('A'), para('Mine'), para('B')], [para('A'), para('Theirs'), para('B')]);
  assert.equal(mergeDocuments(base, mine, theirs), null);
});

test('formatting is a change too: bold added on one side and text changed on the other, in one paragraph, is not merged', async () => {
  const bold: Paragraph = { kind: 'paragraph', properties: {}, children: [run('Title', true)], attrs: {} };
  const [base, mine, theirs] = await three([para('Title'), para('Body.')], [bold, para('Body.')], [para('Title!'), para('Body.')]);
  assert.equal(mergeDocuments(base, mine, theirs), null);
  // In different paragraphs it is.
  const [base2, mine2, theirs2] = await three([para('Title'), para('Body.')], [bold, para('Body.')], [para('Title'), para('Body, longer.')]);
  const merged = mergeDocuments(base2, mine2, theirs2);
  assert.ok(merged);
  assert.equal(paragraphsIn(merged.body)[0]!.children[0]!.kind === 'run' && (paragraphsIn(merged.body)[0]!.children[0] as { properties: { bold?: boolean } }).properties.bold, true);
  assert.deepEqual(texts(merged), ['Title', 'Body, longer.']);
});

test('what isn’t the body is taken from the side that changed it, and is a conflict if both changed it', async () => {
  const fancy = { id: 'Fancy', type: 'paragraph', name: 'Fancy', attrs: {} } as never;
  const [base, mine, theirs] = await three([para('A'), para('B')], [para('A, mine'), para('B')], [para('A'), para('B, theirs')]);
  theirs.styles.styles.push(fancy);
  mine.properties = { title: 'Mine' };
  const merged = mergeDocuments(base, mine, theirs);
  assert.ok(merged);
  assert.deepEqual(texts(merged), ['A, mine', 'B, theirs']);
  assert.ok(merged.styles.styles.some((s) => s.id === 'Fancy'), 'their style');
  assert.equal(merged.properties.title, 'Mine', 'my title');
  // Both changed the title, differently.
  const [base2, mine2, theirs2] = await three([para('A'), para('B')], [para('A, mine'), para('B')], [para('A'), para('B, theirs')]);
  mine2.properties = { title: 'Mine' };
  theirs2.properties = { title: 'Theirs' };
  assert.equal(mergeDocuments(base2, mine2, theirs2), null);
});

test('a comment added or changed on either side is not merged (its range is in the text)', async () => {
  const [base, mine, theirs] = await three([para('A'), para('B')], [para('A, mine'), para('B')], [para('A'), para('B, theirs')]);
  theirs.comments.push({ id: '1', author: 'ai', date: '', paragraphs: [] } as never);
  assert.equal(mergeDocuments(base, mine, theirs), null);
});

test('a table changed on one side and a paragraph on the other are both kept', async () => {
  const [base, mine, theirs] = await three([para('Intro.'), table('a', 'b'), para('Outro.')], [para('Intro, mine.'), table('a', 'b'), para('Outro.')], [para('Intro.'), table('a', 'b, theirs'), para('Outro.')]);
  const merged = mergeDocuments(base, mine, theirs);
  assert.ok(merged);
  assert.deepEqual(texts(merged), ['Intro, mine.', 'a', 'b, theirs', 'Outro.']);
});

test('nothing changed on one side gives the other side', async () => {
  const [base, mine, theirs] = await three([para('A')], [para('A')], [para('A, theirs')]);
  assert.deepEqual(texts(mergeDocuments(base, mine, theirs)!), ['A, theirs']);
  const [base2, mine2, theirs2] = await three([para('A')], [para('A, mine')], [para('A')]);
  assert.deepEqual(texts(mergeDocuments(base2, mine2, theirs2)!), ['A, mine']);
});

test('documents read from files merge the same way, and the result writes and reads back', async () => {
  const write = async (blocks: Block[]) => (await documentOf(blocks)).write();
  const baseBytes = await write([para('First.'), para('Second.'), para('Third.')]);
  const base = await WordDocument.read(baseBytes);
  // Each side starts from the base file, as the editor and the server would.
  const mine = await WordDocument.read(baseBytes);
  (paragraphsIn(mine.body)[0]!.children[0] as { content: { text: string }[] }).content[0]!.text = 'First, mine.';
  const theirs = await WordDocument.read(baseBytes);
  (paragraphsIn(theirs.body)[2]!.children[0] as { content: { text: string }[] }).content[0]!.text = 'Third, theirs.';
  const merged = mergeDocuments(await WordDocument.read(await base.write()), await WordDocument.read(await mine.write()), await WordDocument.read(await theirs.write()));
  assert.ok(merged);
  assert.deepEqual(texts(await WordDocument.read(await merged.write())), ['First, mine.', 'Second.', 'Third, theirs.']);
});

test('the save dates each writer stamps are never a conflict: the later save’s are kept', async () => {
  const [base, mine, theirs] = await three([para('A'), para('B')], [para('A, mine'), para('B')], [para('A'), para('B, theirs')]);
  base.properties = { title: 'T', modified: '2026-01-01T00:00:00Z', lastModifiedBy: 'Base' };
  mine.properties = { title: 'T', modified: '2026-01-02T00:00:00Z', lastModifiedBy: 'Me' };
  theirs.properties = { title: 'T', modified: '2026-01-03T00:00:00Z', lastModifiedBy: 'Them' };
  const merged = mergeDocuments(base, mine, theirs);
  assert.ok(merged);
  assert.deepEqual(merged.properties, { title: 'T', modified: '2026-01-03T00:00:00Z', lastModifiedBy: 'Them' });
});
