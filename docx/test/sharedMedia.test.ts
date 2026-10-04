import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHARED_MEDIA_IN_TEXT, sha256Hex, sharedMediaHash, sharedMediaPart, WordDocument, type Paragraph } from '../src/index.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const withPicture = async (part: string): Promise<WordDocument> => {
  const doc = await WordDocument.create();
  const paragraph: Paragraph = { kind: 'paragraph', properties: {}, attrs: {}, children: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'drawing', inline: true, width: 914400, height: 914400, image: part }] }] };
  doc.body = [paragraph];
  return doc;
};

test('a picture is named for the hash of its bytes, and the name gives the hash back', async () => {
  const hash = await sha256Hex(PNG);
  assert.match(hash, /^[0-9a-f]{64}$/);
  const part = sharedMediaPart(hash, '.PNG');
  assert.equal(part, `word/media/h-${hash}.png`);
  assert.equal(sharedMediaHash(part), hash);
  assert.equal(sharedMediaHash('word/media/image1.png'), null);
  assert.deepEqual(`x ${part} y "${part}"`.match(SHARED_MEDIA_IN_TEXT), [part, part]);
});

test('a part the package does not have is asked for, kept, and written with the document', async () => {
  const part = sharedMediaPart(await sha256Hex(PNG), 'png');
  const doc = await withPicture(part);
  assert.deepEqual(doc.missingMedia(), [part]);
  assert.equal(doc.hasPart(part), false);

  const asked: string[] = [];
  doc.fetchPart = async (wanted) => (asked.push(wanted), PNG);
  assert.deepEqual(await doc.media(part), PNG);
  assert.deepEqual(await doc.media(part), PNG);
  assert.deepEqual(asked, [part], 'asked once; after that it is the document’s own');
  assert.deepEqual(doc.missingMedia(), []);

  const read = await WordDocument.read(await doc.write());
  assert.deepEqual(await read.media(part), PNG);
});

test('missing parts are fetched together before the document is written, and one that cannot be had is left', async () => {
  const have = sharedMediaPart('a'.repeat(64), 'png');
  const lost = sharedMediaPart('b'.repeat(64), 'png');
  const doc = await withPicture(have);
  const paragraph = doc.body[0] as Paragraph;
  (paragraph.children[0] as { content: unknown[] }).content.push({ kind: 'drawing', inline: true, width: 1, height: 1, image: lost });
  doc.fetchPart = async (wanted) => (wanted === have ? PNG : null);
  await doc.fetchMissingMedia();
  assert.deepEqual(doc.missingMedia(), [lost]);
  assert.ok(doc.hasPart(have));
});

test('without a way to fetch, a missing part is an error, as it always was', async () => {
  const doc = await withPicture(sharedMediaPart('c'.repeat(64), 'png'));
  await assert.rejects(() => doc.media(sharedMediaPart('c'.repeat(64), 'png')), /missing part/);
});
