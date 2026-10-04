// Obsidian-style embeds in Markdown (src/formats/embeds.ts, embedMarks.ts): `![[picture.png]]` and `![[Note]]`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphText, paragraphsIn } from '@golemdocs/docx';
import type { Block, Hyperlink, WordDocument } from '@golemdocs/docx';
import { collapseDocument, embedTag } from '../src/formats/embedMarks.ts';
import { resolveEmbeds, type EmbedLookup } from '../src/formats/embeds.ts';
import { documentToMarkdown, markdownToDocument } from '../src/formats/markdown.ts';

/** A PNG's signature and header, enough to be told a picture's type and size. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

const roundTrip = (document: WordDocument): string => documentToMarkdown(document).trim();
const drawings = (document: WordDocument) =>
  paragraphsIn(document.body).flatMap((p) => p.children.flatMap((i) => (i.kind === 'run' ? i.content.filter((c) => c.kind === 'drawing') : [])));

const vault: Record<string, () => Promise<Awaited<ReturnType<EmbedLookup>>>> = {
  'map.png': async () => ({ kind: 'image', bytes: png(400, 200) }),
  Plan: async () => ({ kind: 'document', document: await markdownToDocument('# Plan\n\nFirst point.\n\n## Budget\n\nTen dollars.\n\n## Risks\n\nNone.\n') }),
};
const lookup: EmbedLookup = async (title) => (await vault[title]?.()) ?? null;

test('an embed that is not resolved is a link that writes back as the embed', async () => {
  const document = await markdownToDocument('See ![[map.png]] and ![[Plan#Budget|the budget]].\n');
  const links = paragraphsIn(document.body)[0].children.filter((i): i is Hyperlink => i.kind === 'hyperlink');
  assert.deepEqual(links.map((l) => l.url), ['doc:map.png', 'doc:Plan#Budget']);
  assert.equal(roundTrip(document), 'See ![[map.png]] and ![[Plan#Budget|the budget]].');
});

test('an embedded picture is drawn in place, at its size or the one written, and writes back as the embed', async () => {
  const document = await markdownToDocument('Before ![[map.png]] after\n\n![[map.png|100]]\n\n![[map.png|50x20]]\n');
  await resolveEmbeds(document, lookup);
  const [natural, narrow, boxed] = drawings(document);
  assert.deepEqual([natural.width, natural.height], [400 * 9525, 200 * 9525]);
  assert.deepEqual([narrow.width, narrow.height], [100 * 9525, 50 * 9525]);
  assert.deepEqual([boxed.width, boxed.height], [50 * 9525, 20 * 9525]);
  assert.equal(natural.name, 'embed:map.png');
  assert.equal(paragraphText(paragraphsIn(document.body)[0]).includes('map.png'), false);
  assert.equal(roundTrip(document), 'Before ![[map.png]] after\n\n![[map.png|100]]\n\n![[map.png|50x20]]');
});

test('a picture wider than the page is made to fit', async () => {
  const document = await markdownToDocument('![[map.png]]\n');
  await resolveEmbeds(document, async () => ({ kind: 'image', bytes: png(5000, 1000) }));
  const [shown] = drawings(document);
  assert.ok(shown.width <= 6.5 * 914400);
  assert.equal(shown.height * 5, shown.width);
});

test('an embedded note puts its text in a block of its own, set apart, and writes back as the embed', async () => {
  const document = await markdownToDocument('Intro\n\n![[Plan]]\n\nOutro\n');
  await resolveEmbeds(document, lookup);
  const embed = document.body.find((b) => embedTag(b) !== null) as Extract<Block, { kind: 'wrapper' }>;
  assert.equal(embedTag(embed), 'Plan');
  assert.deepEqual(paragraphsIn(embed.children).map((p) => paragraphText(p)), ['Plan', 'First point.', 'Budget', 'Ten dollars.', 'Risks', 'None.']);
  assert.ok(paragraphsIn(embed.children).every((p) => p.properties.borders?.left));
  assert.equal(roundTrip(document), 'Intro\n\n![[Plan]]\n\nOutro');
});

test('an embedded section is the text under that heading, up to the next one as high', async () => {
  const document = await markdownToDocument('![[Plan#Budget]]\n');
  await resolveEmbeds(document, lookup);
  const embed = document.body.find((b) => embedTag(b) !== null) as Extract<Block, { kind: 'wrapper' }>;
  assert.deepEqual(paragraphsIn(embed.children).map((p) => paragraphText(p)), ['Ten dollars.']);
  assert.equal(roundTrip(document), '![[Plan#Budget]]');
});

test('what is not found, or cannot be shown, stays a link', async () => {
  const document = await markdownToDocument('![[Missing]] ![[Plan#Nowhere]]\n\n![[Plan#Nowhere]]\n\n![[map.png]] ![[Plan]]\n');
  await resolveEmbeds(document, lookup);
  // The picture is drawn; the note beside text stays a link, like the section that isn't there and the title that isn't stored.
  assert.equal(drawings(document).length, 1);
  assert.equal(document.body.some((b) => embedTag(b) !== null), false);
  assert.equal(roundTrip(document), '![[Missing]] ![[Plan#Nowhere]]\n\n![[Plan#Nowhere]]\n\n![[map.png]] ![[Plan]]');
});

test('resolving again looks the embeds up afresh instead of stacking them', async () => {
  const document = await markdownToDocument('![[map.png]]\n\n![[Plan]]\n');
  await resolveEmbeds(document, lookup);
  await resolveEmbeds(document, lookup);
  assert.equal(drawings(document).length, 1);
  assert.equal(document.body.filter((b) => embedTag(b) !== null).length, 1);
  // The picture is gone from the other document: the embed is the link again.
  await resolveEmbeds(document, async () => null);
  assert.equal(drawings(document).length, 0);
  assert.equal(roundTrip(document), '![[map.png]]\n\n![[Plan]]');
});

test('collapsing a document makes embeds links without looking anything up', async () => {
  const document = await markdownToDocument('![[map.png]]\n\n![[Plan]]\n');
  await resolveEmbeds(document, lookup);
  collapseDocument(document);
  assert.equal(drawings(document).length, 0);
  assert.equal(document.body.some((b) => embedTag(b) !== null), false);
});

test('an embedded drawing is its picture with its SVG beside it, and writes back as the embed', async () => {
  const document = await markdownToDocument('![[Sketch.svg]]\n\nAnd ![[Sketch.svg|100]] again.\n');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"/>';
  await resolveEmbeds(document, async () => ({ kind: 'drawing', svg, png: png(800, 400), width: 400, height: 200 }));
  const [first, second] = drawings(document);
  assert.deepEqual([first.width, first.height], [400 * 9525, 200 * 9525]);
  assert.deepEqual([second.width, second.height], [100 * 9525, 50 * 9525]);
  assert.equal(first.name, 'embed:Sketch.svg');
  assert.ok(first.svg && first.image, 'the SVG is kept beside the picture');
  assert.equal(first.svg, second.svg, 'one drawing used twice is stored once');
  assert.equal(new TextDecoder().decode(await document.media(first.svg!)), svg);
  assert.equal(roundTrip(document), '![[Sketch.svg]]\n\nAnd ![[Sketch.svg|100]] again.');
});
