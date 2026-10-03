// The assistant's access to the person's other documents: turning one into numbered paragraphs,
// searching and reading them, and finding one by name. No browser: documents are read from
// Markdown and written to the bytes the cloud stores.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readDocument } from '../src/formats/convert.ts';
import { OtherDocuments, type StoredDocument } from '../src/assistant/libraryDocs.ts';
import { segmentsFromBytes } from '../src/formats/docBytes.ts';
import { paragraphSegments as segmentsOf } from '@golemdocs/docx';
import { describeHits, readSegments, resolveDocument, scoreDocument, termsOf } from '../src/assistant/otherDocs.ts';

const encoder = new TextEncoder();
const markdown = async (text: string) => readDocument('md', encoder.encode(text));
const docxBytes = async (text: string): Promise<ArrayBuffer> => {
  const bytes = await (await markdown(text)).write();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const NOTES = '# Kitchen renovation\n\nThe budget is 12000 dollars.\n\n- Replace the cabinets\n- Paint the walls\n\n1. Call the plumber\n';

test('a document becomes numbered paragraphs with their style and list kind', async () => {
  const segments = segmentsOf(await markdown(NOTES));
  assert.equal(segments[0]!.text, 'Kitchen renovation');
  assert.match(segments[0]!.style ?? '', /heading/i);
  assert.equal(segments[1]!.text, 'The budget is 12000 dollars.');
  assert.equal(segments[1]!.style, undefined);
  assert.equal(segments[2]!.list, 'bullet');
  assert.equal(segments[4]!.list, 'number');
});

test('reading is a part at a time, and says where more is', async () => {
  const segments = segmentsOf(await markdown(NOTES));
  const first = readSegments('Notes', segments, 0, 2);
  assert.match(first, /paragraphs 0 to 1 of 5/);
  assert.match(first, /More follows: call again with start=2/);
  assert.match(first, /\[1\] The budget/);
  assert.match(readSegments('Notes', segments, 99, 2), /nothing at 99/);
  assert.match(readSegments('Empty', [], 0, 5), /no text/);
});

test('terms are lower-case words; a document is ranked by names, headings and how many different words it has', async () => {
  assert.deepEqual(termsOf('The Kitchen, kitchen! a 2'), ['the', 'kitchen']);
  const kitchen = segmentsOf(await markdown(NOTES));
  const other = segmentsOf(await markdown('# Trip\n\nWe visited the kitchen of a famous chef.\n'));
  const terms = termsOf('kitchen budget');
  const a = scoreDocument(terms, { id: 'a', name: 'Home.docx' }, kitchen)!;
  const b = scoreDocument(terms, { id: 'b', name: 'Trip.docx' }, other)!;
  assert.ok(a.score > b.score);
  assert.deepEqual(a.where?.paragraph, 0);
  assert.equal(scoreDocument(terms, { id: 'c', name: 'Taxes.docx' }, segmentsOf(await markdown('Nothing relevant.'))), null);
  // A name alone is enough to be found.
  assert.ok(scoreDocument(termsOf('taxes'), { id: 'c', name: 'Taxes 2025.docx' }, [])!.score > 0);
});

test('search results say how much was looked through', () => {
  assert.match(describeHits('x', [], 3, 3), /^No document matches "x"\.$/);
  assert.match(describeHits('x', [], 80, 200), /80 most recently changed of 200/);
  const text = describeHits('x', [{ id: 'a', name: 'A.docx', score: 3, where: { paragraph: 4, text: 'hello' } }], 1, 1);
  assert.match(text, /1 document matches "x"/);
  assert.match(text, /"A\.docx" \(id a\) \[4\] hello/);
});

test('a document is found by id, by name, by name without its extension, or by part of its name', () => {
  const docs = [
    { id: 'id1', name: 'Budget 2025.docx' },
    { id: 'id2', name: 'Budget 2026.docx' },
    { id: 'id3', name: 'Recipes.md' },
  ];
  assert.equal((resolveDocument('id3', docs) as { id: string }).id, 'id3');
  assert.equal((resolveDocument('budget 2026.DOCX', docs) as { id: string }).id, 'id2');
  assert.equal((resolveDocument('recipes', docs) as { id: string }).id, 'id3');
  assert.equal((resolveDocument('recip', docs) as { id: string }).id, 'id3');
  assert.match(resolveDocument('budget', docs) as string, /More than one document matches "budget".*id1.*id2/);
  assert.match(resolveDocument('nope', docs) as string, /No document is named "nope"/);
  assert.match(resolveDocument('  ', docs) as string, /Say which document/);
});

test('stored bytes: .docx from the account is read', async () => {
  const segments = await segmentsFromBytes(await docxBytes(NOTES));
  assert.equal(segments?.[1]?.text, 'The budget is 12000 dollars.');
});

function library(files: Record<string, { text: string; updatedAt: number; fail?: boolean }>) {
  const loads: string[] = [];
  const docs = async (): Promise<StoredDocument[]> =>
    Object.entries(files).map(([name, f]) => ({
      id: `id-${name}`,
      name,
      updatedAt: f.updatedAt,
      size: f.text.length,
      load: async () => {
        loads.push(name);
        if (f.fail) throw new Error('offline');
        return docxBytes(f.text);
      },
    }));
  return { other: new OtherDocuments(docs), loads };
}

test('searching opens each document once and finds the right one', async () => {
  const { other, loads } = library({
    'Home.docx': { text: NOTES, updatedAt: 3 },
    'Trip.docx': { text: '# Trip\n\nWe went to Lisbon.\n', updatedAt: 2 },
    'Broken.docx': { text: 'x', updatedAt: 1, fail: true },
  });
  const found = await other.search('lisbon');
  assert.match(found, /1 document matches/);
  assert.match(found, /"Trip\.docx" \(id id-Trip\.docx\) \[1\] We went to Lisbon/);
  await other.search('budget');
  // The two that opened are kept; the one that failed is tried again.
  assert.deepEqual(loads.filter((n) => n === 'Home.docx'), ['Home.docx']);
  assert.equal(loads.filter((n) => n === 'Broken.docx').length, 2);
});

test('listing and reading', async () => {
  const { other } = library({ 'A.docx': { text: 'one\n\ntwo', updatedAt: 5 }, 'B.docx': { text: 'three', updatedAt: 9 } });
  const listed = await other.describeAll(0, 10);
  assert.ok(listed.indexOf('B.docx') < listed.indexOf('A.docx'), 'newest first');
  assert.match(await other.read('A.docx', 1, 5), /\[1\] two/);
  assert.match(await other.read('missing', 0, 5), /No document is named/);
  const copy = await other.paragraphs('id-A.docx');
  assert.equal(typeof copy === 'string' ? copy : copy.segments.length, 2);
});

test('a failing document explains itself when read', async () => {
  const { other } = library({ 'Broken.docx': { text: 'x', updatedAt: 1, fail: true } });
  assert.match(await other.read('Broken.docx', 0, 5), /Could not read "Broken\.docx": offline/);
});

test('the server finds the account\'s own documents by meaning; shared and unsent ones are searched here', async () => {
  const files: Record<string, { text: string; cloudId?: string }> = {
    'Home.docx': { text: 'x', cloudId: 'c1' },
    'Shared.docx': { text: 'The orchid needs water on Fridays.' },
    'Unsent.docx': { text: 'Orchid notes, not uploaded yet.' },
  };
  const loads: string[] = [];
  const docs = async (): Promise<StoredDocument[]> =>
    Object.entries(files).map(([name, f], i) => ({
      id: `id-${name}`,
      name,
      updatedAt: 10 - i,
      size: 10,
      ...(f.cloudId && { cloudId: f.cloudId }),
      load: async () => {
        loads.push(name);
        return docxBytes(f.text);
      },
    }));
  const answer = { hits: [{ id: 'c1', name: 'Home.docx', score: 0.8, paragraph: 3, text: 'The plants on the windowsill' }, { id: 'gone', name: 'Old.docx', score: 0.9, paragraph: 0, text: 'deleted since' }], pending: 2 };
  const other = new OtherDocuments(docs, async () => answer);
  const found = await other.search('orchid');
  // The server's hit comes first, with the part that matched; a hit for a document that is no longer there is dropped.
  assert.match(found, /3 documents match/);
  assert.ok(found.indexOf('Home.docx') < found.indexOf('Shared.docx'));
  assert.match(found, /"Home\.docx" \(id id-Home\.docx\) \[3\] The plants/);
  assert.doesNotMatch(found, /Old\.docx/);
  assert.match(found, /2 of the documents are still being prepared/);
  // Only what the server doesn't cover was opened.
  assert.deepEqual(loads.sort(), ['Shared.docx', 'Unsent.docx']);
});

test('without the server, every document is searched here', async () => {
  const loads: string[] = [];
  const other = new OtherDocuments(async () => [{ id: 'a', name: 'A.docx', updatedAt: 1, size: 5, cloudId: 'c', load: async () => (loads.push('A'), docxBytes('lisbon')) }], async () => null);
  assert.match(await other.search('lisbon'), /"A\.docx"/);
  assert.deepEqual(loads, ['A']);
});

test('the assistant searches by the words and #tags in the documents\' indexes first', async () => {
  const stored = (id: string, name: string): StoredDocument => ({ id, name, updatedAt: 1, size: 10, load: async () => docxBytes('nothing relevant') });
  const asked: string[] = [];
  const docs = new OtherDocuments(
    async () => [stored('k1', 'Kitchen.docx'), stored('k2', 'Garden.docx')],
    async () => null,
    async (query) => {
      asked.push(query);
      return { hits: [{ key: 'k1', name: 'Kitchen.docx', score: 9, paragraph: 3, text: 'Buy cabinets #renovation' }, { key: 'open', name: 'Open.docx', score: 8 }], pending: 1 };
    },
  );
  const answer = await docs.search('#renovation');
  assert.deepEqual(asked, ['#renovation']);
  assert.match(answer, /1 document matches/);
  assert.match(answer, /"Kitchen\.docx" \(id k1\) \[3\] Buy cabinets/);
  assert.doesNotMatch(answer, /Open\.docx/); // the open document isn't one of the other documents
  assert.match(answer, /still being prepared/);
  // A tag nobody has is an answer, not a reason to read every document.
  const none = new OtherDocuments(async () => [stored('k1', 'Kitchen.docx')], async () => null, async () => ({ hits: [], pending: 0 }));
  assert.match(await none.search('#nothing'), /No document matches "#nothing"/);
  // Words found nowhere in the indexes fall back to reading the documents.
  const reads = new OtherDocuments(async () => [{ ...stored('k1', 'Kitchen.docx'), load: async () => docxBytes('The budget is 12000 dollars.') }], async () => null, async () => ({ hits: [], pending: 0 }));
  assert.match(await reads.search('budget dollars'), /Kitchen\.docx/);
});
