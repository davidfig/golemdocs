// The assistant and pictures: attached ones, ones its tools fetch (from the open document and the
// library), and how they are sized and kept out of later turns. The model and storage are faked.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { converse, MAX_IMAGES, MAX_IMAGES_PER_MESSAGE, withoutImages, type Deps, type Message, type Reply } from '../src/assistant/conversation.ts';
import { OtherDocuments, type StoredDocument } from '../src/assistant/libraryDocs.ts';
import { fitSize, MODEL_LONGEST_SIDE, pictureForModel } from '../src/formats/imageForModel.ts';
import { imageToDocument } from '../src/formats/imageDoc.ts';
import { sniffImage } from '../src/formats/images.ts';
import { writeWdoc } from '../src/formats/wdoc.ts';
import { agent, agentResult, bytes, openDoc, startWorker, stopWorker } from './workerHarness.ts';

/** A real 1 by 1 PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = Uint8Array.from(Buffer.from(PNG_BASE64, 'base64'));
const URI = `data:image/png;base64,${PNG_BASE64}`;

const reply = (content: string, calls: { name: string; arguments?: string }[] = []): Reply => ({
  message: { role: 'assistant', content, ...(calls.length && { tool_calls: calls.map((c, i) => ({ id: `c${i}`, name: c.name, arguments: c.arguments ?? '{}' })) }) },
  creditsLeft: 90,
});

function fake(replies: Reply[], tool: Deps['tool']) {
  const seen: Message[][] = [];
  let next = 0;
  const deps: Deps = {
    async ask(messages) {
      seen.push(structuredClone(messages));
      return replies[Math.min(next++, replies.length - 1)]!;
    },
    tool,
  };
  return { deps, seen };
}
const signal = () => new AbortController().signal;

// --- the conversation -------------------------------------------------------------------------

test('a picture attached to the request goes with it, and is not sent again on the next request', async () => {
  const { deps, seen } = fake([reply('A dot.')], async () => 'ok');
  const out = await converse(deps, [], { text: 'what is this?', images: [URI] }, signal());
  assert.deepEqual(seen[0], [{ role: 'user', content: 'what is this?', images: [URI] }]);
  assert.equal(out.answer, 'A dot.');
  // What is kept for the next request has no picture in it, but says there was one.
  assert.equal(out.messages.some((m) => m.role === 'user' && m.images), false);
  assert.match(out.messages[0]!.content, /^what is this\? \(a picture was attached here/);
  const again = await converse(deps, out.messages, 'and now?', signal());
  assert.equal(again.messages.some((m) => m.role === 'user' && m.images), false);
});

test('a request with no pictures is the same message as ever', async () => {
  const { deps, seen } = fake([reply('Hi')], async () => 'ok');
  await converse(deps, [], { text: 'hello', images: [] }, signal());
  assert.deepEqual(seen[0], [{ role: 'user', content: 'hello' }]);
});

test('no more than the server takes go with one request', async () => {
  const { deps, seen } = fake([reply('ok')], async () => 'ok');
  await converse(deps, [], { text: 'many', images: Array<string>(MAX_IMAGES_PER_MESSAGE + 3).fill(URI) }, signal());
  assert.equal((seen[0]![0] as { images: string[] }).images.length, MAX_IMAGES_PER_MESSAGE);
});

test('pictures a tool fetches reach the model in a message of their own, after the tool results', async () => {
  const { deps, seen } = fake([reply('', [{ name: 'view_picture', arguments: '{"source":"document","number":0}' }]), reply('It is a dot.')], async () => ({ text: 'Showing picture 0.', images: [URI] }));
  const out = await converse(deps, [], 'what is the picture?', signal());
  const second = seen[1]!;
  assert.deepEqual(second.map((m) => m.role), ['user', 'assistant', 'tool', 'user']);
  assert.equal(second[2]!.content, 'Showing picture 0.');
  assert.deepEqual((second[3] as { images: string[] }).images, [URI]);
  assert.equal(out.answer, 'It is a dot.');
  assert.equal(out.messages.some((m) => m.role === 'user' && m.images), false);
});

test('a tool that only answers in text adds no picture message', async () => {
  const { deps, seen } = fake([reply('', [{ name: 'list_pictures' }]), reply('Done')], async () => 'The document has no pictures.');
  await converse(deps, [], 'list them', signal());
  assert.deepEqual(seen[1]!.map((m) => m.role), ['user', 'assistant', 'tool']);
});

test('pictures past the server\'s limit are not sent: the model is told they were not shown', async () => {
  const fetchSix = async () => ({ text: 'Showing.', images: Array<string>(MAX_IMAGES).fill(URI) });
  const { deps, seen } = fake([reply('', [{ name: 'view_picture' }]), reply('', [{ name: 'view_picture' }]), reply('Done')], fetchSix);
  await converse(deps, [], { text: 'look', images: [URI] }, signal());
  // The first fetch would make seven in all (over the limit of six), so it is turned away.
  assert.deepEqual(seen[1]!.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.match(seen[1]![2]!.content, /Not shown: too many pictures/);
});

test('withoutImages leaves messages with no pictures as they were', () => {
  const messages: Message[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  assert.deepEqual(withoutImages(messages), messages);
});

// --- the library ------------------------------------------------------------------------------

// Stored documents are what the person's library really holds: a .docx in the account, and this
// browser's own .wdoc around one. A picture file is a one-page document with the picture on it.

const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function pictureDocx(): Promise<ArrayBuffer> {
  const image = sniffImage(PNG)!;
  return toBuffer(await (await imageToDocument(image)).write());
}

async function pictureWdoc(): Promise<ArrayBuffer> {
  const document = new Uint8Array(await pictureDocx());
  return toBuffer(await writeWdoc({ manifest: { version: 1, lens: 'png', origin: 'png', pagesCurrent: true }, document, original: null, extensions: {} }));
}

const stored = (id: string, name: string, load: () => Promise<ArrayBuffer>, extra: Partial<StoredDocument> = {}): StoredDocument => ({ id, name, updatedAt: Number(id), size: 3000, load, ...extra });

async function library() {
  const loads: string[] = [];
  const track = (id: string, bytes: () => Promise<ArrayBuffer>) => () => (loads.push(id), bytes());
  const text = toBuffer(new Uint8Array([0, 1, 2, 3, 4, 5]));
  const documents = [
    stored('1', 'Report.docx', track('1', pictureDocx)),
    stored('2', 'Cat.png', track('2', pictureWdoc)),
    stored('3', 'photo.JPG', track('3', pictureDocx), { place: 'shared by Sam' }),
    stored('4', 'Broken.png', track('4', async () => text)),
    stored('5', 'Huge.png', track('5', pictureDocx), { size: 50_000_000 }),
  ];
  return { other: new OtherDocuments(async () => documents), loads };
}

test('the saved picture files are listed by name with their ids, and other documents are left out', async () => {
  const { other } = await library();
  const text = await other.describePictureFiles();
  assert.match(text, /^4 saved picture files/);
  assert.match(text, /"Cat\.png" \(id 2\)/);
  assert.match(text, /"photo\.JPG" \(id 3\), shared by Sam/);
  assert.doesNotMatch(text, /Report/);
  assert.match(await new OtherDocuments(async () => [stored('1', 'Report.docx', pictureDocx)]).describePictureFiles(), /^No saved picture files/);
});

test('a picture file saved in this browser (.wdoc) or in the account (.docx) is looked at, by id or by name', async () => {
  const { other } = await library();
  const expected = { text: 'Showing picture 0 of "Cat.png" (1 by 1 pixels, png).', images: [URI] };
  assert.deepEqual(await other.picture('2', 0), expected);
  assert.deepEqual(await other.picture('Cat.png', 0), expected);
  assert.deepEqual(await other.picture('cat', 0), expected, 'a name without its extension, in any case');
  assert.deepEqual(await other.picture('3', 0), { text: 'Showing picture 0 of "photo.JPG" (1 by 1 pixels, png).', images: [URI] });
});

test('any other document\'s pictures can be looked at too, by number', async () => {
  const { other } = await library();
  assert.deepEqual(await other.picture('Report.docx', 0), { text: 'Showing picture 0 of "Report.docx" (1 by 1 pixels, png).', images: [URI] });
  assert.match(String(await other.picture('Report.docx', 3)), /^Error: "Report\.docx" has 1 picture \(0 to 0\), not 3\./);
});

test('what cannot be looked at is an error the model can read, and costs nothing it should not', async () => {
  const { other, loads } = await library();
  assert.match(String(await other.picture('nothing like it', 0)), /^Error: No document is named/);
  assert.match(String(await other.picture('Broken.png', 0)), /^Error: could not look at "Broken\.png"/);
  assert.match(String(await other.picture('Huge.png', 0)), /^Error: "Huge\.png" is too big to read here/);
  assert.equal(loads.includes('5'), false, 'a document too big is never fetched');
  assert.equal(loads.includes('1'), false, 'and documents not asked about are not fetched at all');
});

// --- sizing -----------------------------------------------------------------------------------

test('a picture is scaled to fit the model\'s longest side, and never enlarged', () => {
  assert.deepEqual(fitSize(4000, 2000), { width: MODEL_LONGEST_SIDE, height: MODEL_LONGEST_SIDE / 2 });
  assert.deepEqual(fitSize(2000, 4000), { width: MODEL_LONGEST_SIDE / 2, height: MODEL_LONGEST_SIDE });
  assert.deepEqual(fitSize(300, 200), { width: 300, height: 200 });
  assert.deepEqual(fitSize(10_000, 1), { width: MODEL_LONGEST_SIDE, height: 1 });
});

test('a small picture goes to the model untouched, as a data URI', async () => {
  assert.equal(await pictureForModel(PNG), URI);
  await assert.rejects(pictureForModel(new TextEncoder().encode('just some text in here')), /not a picture/);
});

// --- the open document's pictures, through the layout worker ----------------------------------

before(startWorker);
after(stopWorker);

const html = (body: string) => openDoc({ kind: 'html', name: 'Test.html', bytes: bytes(`<html><body>${body}</body></html>`) });

test('list_pictures numbers the document\'s pictures with their paragraphs', async () => {
  const doc = await html(`<p>Intro</p><p>Look: <img src="${URI}" alt="A dot"></p><p><img src="${URI}"></p>`);
  const out = await agent(doc, 'list_pictures');
  assert.match(out, /^The open document has 2 pictures:/);
  assert.match(out, /\[0\] in paragraph 1: A dot/);
  assert.match(out, /\[1\] in paragraph 2/);
  assert.equal(await agent(await html('<p>No pictures here.</p>'), 'list_pictures'), 'The open document has no pictures.');
});

test('view_picture hands the picture over for the model to look at', async () => {
  const doc = await html(`<p><img src="${URI}"></p>`);
  const out = await agentResult(doc, 'view_picture', { source: 'document', number: 0 });
  assert.match(out.result, /^Showing picture 0 \(1 by 1 pixels, png\)\./);
  assert.deepEqual(out.images, [URI]);
});

test('view_picture says what is wrong instead of failing', async () => {
  const doc = await html(`<p><img src="${URI}"></p>`);
  assert.match((await agentResult(doc, 'view_picture', { source: 'document', number: 5 })).result, /^Error: there is no picture 5; the document has 1 \(0 to 0\)/);
  assert.match((await agentResult(doc, 'view_picture', { source: 'nowhere' })).result, /^Error: `source` must be/);
  assert.equal((await agentResult(doc, 'view_picture', { source: 'document', number: 5 })).images, undefined);
  assert.match((await agentResult(await html('<p>Text</p>'), 'view_picture', { source: 'document' })).result, /the document has no pictures/);
});
