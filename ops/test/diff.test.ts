import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphsIn, paragraphText, WordDocument, type Block, type Paragraph } from '@golemdocs/docx';
import { diffDocuments, Replica } from '../src/index.ts';

const run = (text: string, bold = false) => ({ kind: 'run' as const, properties: bold ? { bold: true } : {}, attrs: {}, content: [{ kind: 'text' as const, text }] });
const para = (text: string, properties: Paragraph['properties'] = {}): Paragraph => ({ kind: 'paragraph', properties, children: text ? [run(text)] : [], attrs: {} });
const cell = (text: string) => ({ kind: 'cell' as const, properties: {}, attrs: {}, children: [para(text)] });
const table = (...texts: string[]): Block => ({ kind: 'table', properties: {}, grid: texts.map(() => 3000), rows: [{ kind: 'row', properties: {}, attrs: {}, cells: texts.map(cell) }] });

async function documentOf(blocks: Block[]): Promise<WordDocument> {
  const doc = await WordDocument.create();
  doc.body = structuredClone(blocks);
  return doc;
}

/** A bullet list definition: instance `id` on abstract `abstract`. */
function addList(doc: WordDocument, id: number, abstract: number, format = 'bullet'): void {
  doc.numbering.abstracts.push({ id: abstract, levels: [{ level: 0, format, text: '•', attrs: {} } as never], attrs: {} });
  doc.numbering.instances.push({ id, abstractId: abstract, overrides: [], attrs: {} });
}

const texts = (doc: WordDocument) => paragraphsIn(doc.body).map(paragraphText);

/** Opens `before`, diffs it against `after` and applies the result; returns the replica and the diff. */
async function roundTrip(before: WordDocument, after: WordDocument) {
  const replica = new Replica(before, { clientId: 't' });
  const ids = paragraphsIn(before.body).map((p) => replica.id(p));
  const diff = diffDocuments(before, after, () => replica.newId());
  assert.ok(diff, 'the change can be made with operations');
  const { applied } = replica.external(diff.ops);
  return { replica, diff, ids, applied };
}

test('a word changed in one paragraph changes only that text, and the paragraph keeps its id', async () => {
  const before = await documentOf([para('One two three.'), para('The quick brown fox.'), para('Last.')]);
  const after = await documentOf([para('One two three.'), para('The slow brown fox.'), para('Last.')]);
  const { replica, diff, ids } = await roundTrip(before, after);
  assert.deepEqual(texts(replica.doc), ['One two three.', 'The slow brown fox.', 'Last.']);
  assert.deepEqual(diff.ops.map((op) => op.type), ['delete', 'insertContent']);
  assert.deepEqual(paragraphsIn(replica.doc.body).map((p) => replica.id(p)), ids);
  assert.deepEqual(diff.changes, [{ paragraph: ids[1], from: 4, to: 8 }]);
});

test('an unchanged file gives no operations', async () => {
  const blocks = [para('Same.'), table('a', 'b'), para('Again.')];
  const diff = diffDocuments(await documentOf(blocks), await documentOf(blocks), () => 'X');
  assert.deepEqual(diff, { ops: [], changes: [] });
});

test('paragraphs added and removed: the others are left alone, and a caret after them stays on its text', async () => {
  const before = await documentOf([para('A'), para('B'), para('C'), para('D')]);
  const after = await documentOf([para('New first'), para('A'), para('C'), para('D'), para('New last')]);
  const replica = new Replica(before, { clientId: 't' });
  const [, , c] = paragraphsIn(before.body).map((p) => replica.id(p));
  const diff = diffDocuments(before, after, () => replica.newId())!;
  const { mapping } = replica.external(diff.ops);
  assert.deepEqual(texts(replica.doc), ['New first', 'A', 'C', 'D', 'New last']);
  assert.deepEqual(Replica.mapSelection({ anchor: { paragraph: c, offset: 1 }, focus: { paragraph: c, offset: 1 } }, mapping).focus, { paragraph: c, offset: 1 });
  assert.equal(diff.changes.length, 2);
  assert.ok(diff.changes.every((x) => x.from === 0 && x.to > 0));
});

test('formatting changed on text that reads the same is changed too', async () => {
  const before = await documentOf([para('Make this bold')]);
  const after = await documentOf([{ kind: 'paragraph', properties: {}, attrs: {}, children: [run('Make this '), run('bold', true)] }]);
  const { replica } = await roundTrip(before, after);
  const runs = (replica.doc.body[0] as Paragraph).children;
  assert.equal(runs.length, 2);
  assert.deepEqual((runs[1] as ReturnType<typeof run>).properties, { bold: true });
});

test('a heading turned into a paragraph sets its properties', async () => {
  const before = await documentOf([para('Title', { style: 'Heading1' }), para('Text')]);
  const after = await documentOf([para('Title'), para('Text')]);
  const { replica, diff } = await roundTrip(before, after);
  assert.deepEqual(diff.ops.map((op) => op.type), ['setParagraphProperties']);
  assert.equal((replica.doc.body[0] as Paragraph).properties.style, undefined);
});

test('a table added beside an edited paragraph', async () => {
  const before = await documentOf([para('Intro'), para('Body text')]);
  const after = await documentOf([para('Intro'), table('x', 'y'), para('Body text, longer')]);
  const { replica } = await roundTrip(before, after);
  assert.deepEqual(texts(replica.doc), ['Intro', 'x', 'y', 'Body text, longer']);
  assert.equal(replica.doc.body[1].kind, 'table');
});

test('a list added before another: the existing list keeps its definition, the new one gets its own', async () => {
  const before = await documentOf([para('Text'), para('old item', { style: 'ListParagraph', numbering: { id: 1, level: 0 } })]);
  addList(before, 1, 0);
  // Read again, the file numbers its lists in order: the new one is 1 and the old one 2.
  const after = await documentOf([para('new item', { style: 'ListParagraph', numbering: { id: 1, level: 0 } }), para('Text'), para('old item', { style: 'ListParagraph', numbering: { id: 2, level: 0 } })]);
  addList(after, 1, 0, 'decimal');
  addList(after, 2, 1);
  const { replica, diff } = await roundTrip(before, after);
  assert.deepEqual(texts(replica.doc), ['new item', 'Text', 'old item']);
  const [added, , old] = paragraphsIn(replica.doc.body);
  assert.equal(old.properties.numbering?.id, 1);
  assert.notEqual(added.properties.numbering?.id, 1);
  assert.equal(diff.ops.filter((op) => op.type === 'setList').length, 1);
  const instance = replica.doc.numbering.instances.find((x) => x.id === added.properties.numbering?.id)!;
  assert.equal(replica.doc.numbering.abstracts.find((x) => x.id === instance.abstractId)?.levels[0].format, 'decimal');
});

test('a changed style sheet is not done with operations', async () => {
  const before = await documentOf([para('A')]);
  const after = await documentOf([para('A')]);
  after.styles = { ...after.styles, styles: [...after.styles.styles, { id: 'Mine', type: 'paragraph', name: 'Mine', attrs: {} } as never] };
  assert.equal(diffDocuments(before, after, () => 'X'), null);
});

test('everything replaced', async () => {
  const before = await documentOf([para('one'), para('two'), table('t')]);
  const after = await documentOf([table('u', 'v'), para('three'), para('four'), para('five')]);
  const { replica } = await roundTrip(before, after);
  assert.deepEqual(texts(replica.doc), ['u', 'v', 'three', 'four', 'five']);
});

test('random edits are reproduced exactly', async () => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const words = 'alpha beta gamma delta epsilon zeta eta theta'.split(' ');
  const sentence = () => Array.from({ length: 1 + Math.floor(rand() * 6) }, () => words[Math.floor(rand() * words.length)]).join(' ');
  let skipped = 0;
  for (let round = 0; round < 60; round++) {
    const blocks: Block[] = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => (rand() < 0.15 ? table(sentence()) : para(sentence(), rand() < 0.2 ? { style: 'Heading2' } : {})));
    const edited = structuredClone(blocks);
    for (let k = Math.floor(rand() * 4); k >= 0; k--) {
      const at = Math.floor(rand() * (edited.length + 1));
      const r = rand();
      if (r < 0.3) edited.splice(at, 0, para(sentence()));
      else if (r < 0.5 && edited.length > 1) edited.splice(Math.min(at, edited.length - 1), 1);
      else if (edited[at]?.kind === 'paragraph') edited[at] = para(paragraphText(edited[at] as Paragraph).replace(/\w+/, sentence()), (edited[at] as Paragraph).properties);
      else edited.splice(at, 0, table(sentence()));
    }
    const before = await documentOf(blocks);
    const after = await documentOf(edited);
    const expected = texts(after);
    const replica = new Replica(before, { clientId: 't' });
    const diff = diffDocuments(before, after, () => replica.newId());
    if (!diff) {
      skipped++; // e.g. a stretch between two tables: opened again instead
      continue;
    }
    replica.external(diff.ops);
    assert.deepEqual(texts(replica.doc), expected, `round ${round}`);
  }
  assert.ok(skipped < 6, `${skipped} of 60 opened again`);
});
