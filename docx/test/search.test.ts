import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex, decodeIndex, encodeIndex, parseQuery, parseTagAddress, readTag, searchIndex, tagAddress, tagsIn, tagsOf, tokenize, type Segment } from '../src/index.ts';

const seg = (text: string, style?: string): Segment => ({ text, ...(style && { style }) });

test('a tag starts at a # that follows a space or punctuation and holds a letter', () => {
  assert.deepEqual(readTag('#plan', 0), { name: 'plan', end: 5 });
  assert.deepEqual(readTag('see #plan, then', 4), { name: 'plan', end: 9 });
  assert.deepEqual(readTag('(#work/plans).', 1), { name: 'work/plans', end: 12 });
  assert.deepEqual(readTag('#plan-', 0), { name: 'plan', end: 5 });
  assert.deepEqual(readTag('#año', 0), { name: 'año', end: 4 });
  assert.equal(readTag('C#', 1), null);
  assert.equal(readTag('a#b', 1), null);
  assert.equal(readTag('&#39;', 1), null);
  assert.equal(readTag('http://x/#top', 9), null);
  assert.equal(readTag('#1', 0), null);
  assert.equal(readTag('# Heading', 0), null);
  assert.equal(readTag('##x', 0), null);
  assert.equal(readTag('#', 0), null);
  assert.equal(readTag(`#${'a'.repeat(100)}`, 0), null);
});

test('tagsIn lists every tag, and tag addresses round trip', () => {
  assert.deepEqual(tagsIn('#a1 and C# and #b2/x, #a1'), ['a1', 'b2/x', 'a1']);
  assert.equal(parseTagAddress(tagAddress('work/plans')), 'work/plans');
  assert.equal(parseTagAddress('TAG:Plan%20B'), 'Plan B');
  assert.equal(parseTagAddress('tag:#plan'), 'plan');
  assert.equal(parseTagAddress('tag:'), null);
  assert.equal(parseTagAddress('doc:plan'), null);
});

test('tokenize lower-cases, folds accents, and splits CJK into characters and pairs', () => {
  assert.deepEqual(tokenize('The Café, a 2024 plan!'), ['the', 'cafe', '2024', 'plan']);
  assert.deepEqual(tokenize('日本語'), ['日', '日本', '本', '本語', '語']);
  assert.deepEqual(tokenize('abc日本'), ['abc', '日', '日本', '本']);
  assert.deepEqual(tokenize('한국어'), ['한', '한국', '국', '국어', '어']);
});

const index = buildIndex([seg('Quarterly plan', 'Heading 1'), seg('We ship the Alpha in March #roadmap/q1 and #Launch.'), seg('Budget notes about the alpha build'), seg('Nothing here')]);

test('a search needs every word, and finds the best paragraph', () => {
  const hit = searchIndex(index, parseQuery('alpha march'))!;
  assert.equal(hit.paragraph, 1);
  assert.match(hit.text, /Alpha in March/);
  assert.equal(searchIndex(index, parseQuery('alpha zebra')), null);
  assert.equal(searchIndex(index, parseQuery('')), null);
  assert.equal(searchIndex(index, parseQuery('x')), null);
});

test('words match as prefixes and without accents', () => {
  assert.equal(searchIndex(index, parseQuery('quart'))?.paragraph, 0);
  assert.equal(searchIndex(buildIndex([seg('un café noir')]), parseQuery('CAFE'))?.paragraph, 0);
});

test('a heading wins a tie, and the name can supply a word', () => {
  assert.equal(searchIndex(buildIndex([seg('one plan here'), seg('The plan', 'Heading 1')]), parseQuery('plan'))?.paragraph, 1);
  const hit = searchIndex(index, parseQuery('budget handbook'), 'Handbook.docx');
  assert.ok(hit);
  assert.equal(hit.paragraph, 2);
  assert.equal(searchIndex(index, parseQuery('handbook'), 'Handbook.docx')?.paragraphs, 0);
});

test('tags are found by #name, ignoring case, including the tags inside one', () => {
  assert.deepEqual(parseQuery('#Launch alpha'), { words: ['alpha'], tags: ['launch'], phrases: [], not: { words: [], tags: [] } });
  assert.equal(searchIndex(index, parseQuery('#launch'))?.paragraph, 1);
  assert.equal(searchIndex(index, parseQuery('#roadmap'))?.paragraph, 1);
  assert.equal(searchIndex(index, parseQuery('#roadmap/q1'))?.paragraph, 1);
  assert.equal(searchIndex(index, parseQuery('#road')), null);
  // Words and tags only have to be somewhere in the document, not in one paragraph.
  assert.equal(searchIndex(index, parseQuery('#roadmap budget'))?.paragraphs, 2);
  assert.equal(searchIndex(index, parseQuery('#roadmap zebra')), null);
  assert.equal(searchIndex(index, parseQuery('#launch alpha'))?.paragraph, 1);
  // The heading with the word beats the paragraph with the tag.
  assert.equal(searchIndex(index, parseQuery('plan #launch'))?.paragraph, 0);
  assert.deepEqual([...tagsOf(index)], [['roadmap/q1', 1], ['launch', 1]]);
});

test('a # with no tag after it is not a search', () => {
  assert.deepEqual(parseQuery('#'), { words: [], tags: [], phrases: [], not: { words: [], tags: [] } });
  assert.deepEqual(parseQuery('c# plan'), { words: ['plan'], tags: [], phrases: [], not: { words: [], tags: [] } });
});

test('long paragraphs keep only their start, but every word is found', () => {
  const text = `${'filler '.repeat(120)}needle`;
  const big = buildIndex([seg(text)]);
  assert.ok(big.p[0]!.length <= 400);
  assert.equal(searchIndex(big, parseQuery('needle'))?.paragraph, 0);
});

test('an index survives encoding, and a damaged or foreign one is refused', async () => {
  const back = await decodeIndex(await encodeIndex(index));
  assert.deepEqual(back, index);
  assert.equal(await decodeIndex(new Uint8Array([1, 2, 3])), null);
  assert.equal(await decodeIndex(await encodeIndex({ ...index, v: 99 })), null);
  assert.equal(searchIndex(back!, parseQuery('#launch'))?.paragraph, 1);
});

test('odd words cannot break the index', () => {
  const odd = buildIndex([seg('__proto__ constructor hasOwnProperty toString #__proto__x')]);
  assert.equal(searchIndex(odd, parseQuery('constructor'))?.paragraph, 0);
  assert.equal(searchIndex(odd, parseQuery('toString'))?.paragraph, 0);
});

test('a quoted phrase has to be in one paragraph, in order', () => {
  const doc = buildIndex([seg('We ship the alpha in March'), seg('March is when the alpha ships'), seg('Alpha and beta together')]);
  assert.deepEqual(parseQuery('"alpha in March" plan').phrases, ['alpha in march']);
  assert.equal(searchIndex(doc, parseQuery('"alpha in march"'))?.paragraph, 0);
  assert.equal(searchIndex(doc, parseQuery('"march alpha"')), null); // the words are there, never in that order
  assert.equal(searchIndex(doc, parseQuery('"alpha and beta"'))?.paragraph, 2);
  assert.equal(searchIndex(doc, parseQuery('"alpha beta"')), null); // "and" is between them
  assert.equal(searchIndex(doc, parseQuery('"alpha zebra"')), null);
  // Case, accents and punctuation between the words don't matter.
  assert.equal(searchIndex(buildIndex([seg('Un café, noir!')]), parseQuery('"CAFE noir"'))?.paragraph, 0);
  // A long paragraph keeps only its start: a phrase that may be further along is not ruled out.
  const long = buildIndex([seg(`${'filler '.repeat(120)}red balloon`)]);
  assert.equal(searchIndex(long, parseQuery('"red balloon"'))?.paragraph, 0);
});

test('-word and -#tag leave out the documents that have them', () => {
  assert.deepEqual(parseQuery('plan -budget -#launch well-known'), { words: ['plan', 'well', 'known'], tags: [], phrases: [], not: { words: ['budget'], tags: ['launch'] } });
  assert.equal(searchIndex(index, parseQuery('plan')) !== null, true);
  assert.equal(searchIndex(index, parseQuery('alpha -budget')), null);
  assert.equal(searchIndex(index, parseQuery('alpha -#launch')), null);
  assert.equal(searchIndex(index, parseQuery('alpha -zebra'))?.paragraph, 1);
  // Whole words only: -bud keeps a document that has "budget".
  assert.equal(searchIndex(index, parseQuery('alpha -bud'))?.paragraph, 1);
  // Nothing to search for but exclusions is nothing.
  assert.equal(searchIndex(index, parseQuery('-budget')), null);
});
