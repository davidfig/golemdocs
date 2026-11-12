// Live blocks (src/live/, docs/live-blocks.md): tags, the spreadsheet and CSV producers, stamps, and updating a document.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument, paragraphText } from '@golemdocs/docx';
import type { Block, Paragraph, Table } from '@golemdocs/docx';
import { findLive, liveTag, liveWrapper, parseLiveTag, liveTagText } from '../src/live/liveMarks.ts';
import { sheetResult } from '../src/live/sheetSource.ts';
import { produce, splitAddress, stampOf } from '../src/live/sources.ts';
import type { SourceFile } from '../src/live/sources.ts';
import { updateLive } from '../src/live/update.ts';
import { Kind } from '../src/sheet/model/column.ts';
import { Workbook } from '../src/sheet/model/workbook.ts';
import { Worksheet } from '../src/sheet/model/worksheet.ts';
import { writeWorkbook } from '../src/sheet/xlsx/write.ts';

/** A workbook: a Budget sheet with items and amounts, and a defined name for the total. */
async function budget(rent = 2100): Promise<Uint8Array> {
  const book = new Workbook();
  const sheet = new Worksheet('Budget', 1);
  book.sheets.push(sheet);
  const text = (r: number, c: number, s: string) => sheet.grid.set(r, c, Kind.String, book.strings.add(s), 0);
  const number = (r: number, c: number, n: number) => sheet.grid.set(r, c, Kind.Number, n, 0);
  text(0, 0, 'Item');
  text(0, 1, 'Amount');
  text(1, 0, 'Rent');
  number(1, 1, rent);
  text(2, 0, 'Food');
  number(2, 1, 640);
  text(3, 0, 'Total');
  number(3, 1, rent + 640);
  book.names.push({ name: 'Expenses', formula: 'Budget!$A$1:$B$3' }, { name: 'Total', formula: 'Budget!$B$4' });
  return writeWorkbook(book, { recalculate: false });
}

const cellTexts = (table: Table): string[][] =>
  table.rows.map((r) => (r.kind === 'row' ? r.cells.map((c) => (c.kind === 'cell' ? c.children.map((b) => (b.kind === 'paragraph' ? paragraphText(b) : '')).join('') : '')) : []));

test('a tag reads back its source and stamp, spaces in the name and all', () => {
  const tag = { source: 'My Budget.xlsx#Expenses', stamp: '3f9a2c1e' };
  assert.equal(liveTagText(tag), 'live:My Budget.xlsx#Expenses stamp=3f9a2c1e');
  assert.deepEqual(parseLiveTag(liveTagText(tag)), tag);
  assert.deepEqual(parseLiveTag('live:Budget.xlsx'), { source: 'Budget.xlsx', stamp: '' });
  assert.equal(parseLiveTag('embed:Note'), null);
  assert.deepEqual(liveTag(liveWrapper(tag, [])), tag);
  assert.deepEqual(splitAddress('Budget.xlsx#Summary!A1:B2'), { title: 'Budget.xlsx', fragment: 'Summary!A1:B2', query: '' });
  assert.deepEqual(splitAddress('Budget.xlsx#Expenses?sort=-Amount'), { title: 'Budget.xlsx', fragment: 'Expenses', query: 'sort=-Amount' });
});

test('a workbook gives a defined range as a table and a defined cell as a value', async () => {
  const bytes = await budget();
  const range = await sheetResult(bytes, 'Expenses');
  assert.equal(range.kind, 'table');
  if (range.kind !== 'table') return;
  assert.deepEqual(range.rows, [['Item', 'Amount'], ['Rent', '2100'], ['Food', '640']]);
  assert.equal(range.header, true);
  assert.deepEqual(range.align, ['left', 'right']);
  assert.deepEqual(await sheetResult(bytes, 'Total'), { kind: 'value', text: '2740' });
  assert.deepEqual(await sheetResult(bytes, 'Budget!B2'), { kind: 'value', text: '2100' });
  assert.deepEqual(await sheetResult(bytes, 'A3:B3'), { kind: 'table', rows: [['Food', '640']], header: false, align: ['left', 'right'] });
  assert.deepEqual(await sheetResult(bytes, 'Nope'), { kind: 'error', code: 'notFound', detail: 'Nope' });
  assert.deepEqual(await sheetResult(bytes, 'table:Nope'), { kind: 'error', code: 'noTable', detail: 'Nope' });
});

test('a CSV gives its rows, numbers aligned right', async () => {
  const result = await produce({ name: 'Meals.csv', bytes: new TextEncoder().encode('Day,Calories\nMon,2100\nTue,1900\n') }, '');
  assert.deepEqual(result, { kind: 'table', rows: [['Day', 'Calories'], ['Mon', '2100'], ['Tue', '1900']], header: true, align: ['left', 'right'] });
});

test('the same result always has the same stamp', async () => {
  const a = await sheetResult(await budget(), 'Expenses');
  const b = await sheetResult(await budget(), 'Expenses');
  assert.equal(stampOf(a), stampOf(b));
  assert.notEqual(stampOf(a), stampOf(await sheetResult(await budget(2200), 'Expenses')));
  // Another part of the workbook changing leaves this block's stamp, so its document is not rewritten.
  assert.equal(stampOf(await sheetResult(await budget(), 'A3:B3')), stampOf(await sheetResult(await budget(2200), 'A3:B3')));
});

/** A document with a block for the expenses and, in a sentence, the total. */
async function note(): Promise<WordDocument> {
  const document = await WordDocument.create();
  const sentence: Paragraph = {
    kind: 'paragraph',
    properties: {},
    children: [
      { kind: 'run', properties: {}, content: [{ kind: 'text', text: 'So far: ' }], attrs: {} },
      liveWrapper({ source: 'Budget.xlsx#Total', stamp: '' }, []),
      { kind: 'run', properties: {}, content: [{ kind: 'text', text: '.' }], attrs: {} },
    ],
    attrs: {},
  };
  document.body = [liveWrapper<Block>({ source: 'Budget.xlsx#Expenses', stamp: '' }, []), sentence];
  return document;
}

test('updating fills each block, rewrites only what changed, and keeps a block whose source is gone', async () => {
  let bytes = await budget();
  const files: Record<string, () => SourceFile | null> = { 'budget.xlsx': () => ({ name: 'Budget.xlsx', bytes }) };
  const lookup = async (title: string) => files[title.toLowerCase()]?.() ?? null;
  const document = await note();

  assert.deepEqual(await updateLive(document, lookup), { updated: 2, problems: [] });
  const table = (document.body[0] as Extract<Block, { kind: 'wrapper' }>).children[0] as Table;
  assert.deepEqual(cellTexts(table), [['Item', 'Amount'], ['Rent', '2100'], ['Food', '640']]);
  assert.equal(paragraphText(document.body[1] as Paragraph), 'So far: 2740.');
  assert.equal(findLive(document).every((at) => at.tag.stamp.length === 8), true);

  assert.deepEqual(await updateLive(document, lookup), { updated: 0, problems: [] });

  bytes = await budget(2200);
  assert.deepEqual(await updateLive(document, lookup), { updated: 2, problems: [] });
  assert.equal(paragraphText(document.body[1] as Paragraph), 'So far: 2840.');

  files['budget.xlsx'] = () => null;
  const report = await updateLive(document, lookup);
  assert.equal(report.updated, 0);
  assert.deepEqual(report.problems.map((p) => p.code), ['missing', 'missing']);
  assert.equal(paragraphText(document.body[1] as Paragraph), 'So far: 2840.');
});

// --- Markdown ----------------------------------------------------------------------------------

import { documentToMarkdown, markdownToDocument } from '../src/formats/markdown.ts';

const NOTE = `# Budget

<!-- golem:live Budget.xlsx#Expenses stamp=3f9a2c1e -->

| Item | Amount |
| --- | ---: |
| Rent | 2100 |

<!-- /golem:live -->

So far <!-- golem:live Budget.xlsx#Total stamp=0a0b0c0d -->**2740**<!-- /golem:live --> spent.`;

test('Markdown reads a live block and a live value into content controls, and writes them back as they were', async () => {
  const document = await markdownToDocument(`${NOTE}\n`);
  const live = findLive(document);
  assert.deepEqual(live.map((at) => [at.kind, at.tag.source, at.tag.stamp]), [
    ['block', 'Budget.xlsx#Expenses', '3f9a2c1e'],
    ['inline', 'Budget.xlsx#Total', '0a0b0c0d'],
  ]);
  assert.equal((live[0].wrapper.children[0] as Block).kind, 'table');
  assert.equal(documentToMarkdown(document).trim(), NOTE);
});

test('a Markdown block filled from a workbook writes its new result between its markers', async () => {
  const bytes = await budget();
  const document = await markdownToDocument('Costs:\n\n<!-- golem:live Budget.xlsx#Expenses -->\n\n<!-- /golem:live -->\n\nTotal <!-- golem:live Budget.xlsx#Total --><!-- /golem:live -->.\n');
  await updateLive(document, async () => ({ name: 'Budget.xlsx', bytes }));
  const [block, value] = findLive(document);
  assert.equal(
    documentToMarkdown(document).trim(),
    `Costs:\n\n<!-- golem:live Budget.xlsx#Expenses stamp=${block.tag.stamp} -->\n\n| Item | Amount |\n| --- | ---: |\n| Rent | 2100 |\n| Food | 640 |\n\n<!-- /golem:live -->\n\nTotal <!-- golem:live Budget.xlsx#Total stamp=${value.tag.stamp} -->2740<!-- /golem:live -->.`,
  );
});

test('a marker with no end is left as text', async () => {
  const document = await markdownToDocument('<!-- golem:live Budget.xlsx -->\n\nText\n');
  assert.equal(findLive(document).length, 0);
});

// --- Word --------------------------------------------------------------------------------------

test('a Word document keeps its live blocks through a save, tag, lock and result', async () => {
  const bytes = await budget();
  const document = await note();
  await updateLive(document, async () => ({ name: 'Budget.xlsx', bytes }));
  const before = findLive(document).map((at) => at.tag);
  const back = await WordDocument.read(await document.write());
  assert.deepEqual(findLive(back).map((at) => at.tag), before);
  assert.equal(paragraphText(back.body.find((b) => b.kind === 'paragraph') as Paragraph), 'So far: 2740.');
  assert.deepEqual(await updateLive(back, async () => ({ name: 'Budget.xlsx', bytes })), { updated: 0, problems: [] });
});

// --- HTML --------------------------------------------------------------------------------------

import { documentToHtml, htmlToDocument } from '../src/formats/html.ts';

test('HTML keeps live blocks as elements carrying their source and stamp', async () => {
  const bytes = await budget();
  const document = await note();
  await updateLive(document, async () => ({ name: 'Budget.xlsx', bytes }));
  const tags = findLive(document).map((at) => at.tag);
  const html = await documentToHtml(document);
  assert.match(html, new RegExp(`<div data-golem-live="Budget.xlsx#Expenses" data-golem-stamp="${tags[0].stamp}">`));
  assert.match(html, new RegExp(`<span data-golem-live="Budget.xlsx#Total" data-golem-stamp="${tags[1].stamp}">2740</span>`));
  const { document: back } = await htmlToDocument(html);
  assert.deepEqual(findLive(back).map((at) => at.tag), tags);
  assert.deepEqual(await updateLive(back, async () => ({ name: 'Budget.xlsx', bytes })), { updated: 0, problems: [] });
});

// --- OpenDocument ------------------------------------------------------------------------------

import { readOdt, writeOdt } from '@golemdocs/odt';

test('ODT keeps a live block as a named section and a live value as a described field', async () => {
  const bytes = await budget();
  const document = await note();
  await updateLive(document, async () => ({ name: 'Budget.xlsx', bytes }));
  const tags = findLive(document).map((at) => at.tag);
  const { document: back } = await readOdt(await writeOdt(document));
  assert.deepEqual(findLive(back).map((at) => at.tag), tags);
  assert.equal(paragraphText(back.body.find((b) => b.kind === 'paragraph') as Paragraph), 'So far: 2740.');
  assert.deepEqual(await updateLive(back, async () => ({ name: 'Budget.xlsx', bytes })), { updated: 0, problems: [] });
});

// --- The vault graph: links and renames --------------------------------------------------------

import { buildIndex, paragraphSegments } from '@golemdocs/docx';
import { rewriteDocumentLinks } from '../src/formats/docLinks.ts';

test('a document links to the sources of its live blocks, so the search index knows what depends on what', async () => {
  const document = await note();
  await updateLive(document, async () => ({ name: 'Budget.xlsx', bytes: await budget() }));
  assert.deepEqual(Object.keys(buildIndex(paragraphSegments(document)).l), ['Budget.xlsx']);
});

test('renaming a source rewrites the live blocks that name it, stamp and part kept', async () => {
  const document = await note();
  await updateLive(document, async () => ({ name: 'Budget.xlsx', bytes: await budget() }));
  const stamps = findLive(document).map((at) => at.tag.stamp);
  const bytes = await document.write();
  const { bytes: out, changed } = await rewriteDocumentLinks(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, new Map([['Budget.xlsx', 'Home budget.xlsx']]));
  assert.equal(changed, 2);
  const back = await WordDocument.read(out!);
  assert.deepEqual(findLive(back).map((at) => at.tag), [
    { source: 'Home budget.xlsx#Expenses', stamp: stamps[0] },
    { source: 'Home budget.xlsx#Total', stamp: stamps[1] },
  ]);
});

// --- Keeping the vault up to date --------------------------------------------------------------

import { LiveKeeper } from '../src/live/keeper.ts';
import { sourceBytes, updateStoredLive } from '../src/live/stored.ts';
import { delimitedWdoc, isWdoc, readWdoc } from '../src/formats/wdoc.ts';
import { textSegments } from '@golemdocs/docx';

/** A vault in memory: documents by key, and what each links to (as the search index would say). */
async function vault() {
  const files = new Map<string, { name: string; bytes: Uint8Array }>();
  files.set('b', { name: 'Budget.xlsx', bytes: await budget() });
  files.set('n', { name: 'Notes.docx', bytes: await (await note()).write() });
  files.set('o', { name: 'Other.docx', bytes: await (await WordDocument.create()).write() });
  const writes: string[] = [];
  const keeper = new LiveKeeper(
    {
      entries: () => [...files].map(([key, f]) => ({ key, name: f.name })),
      links: async () => new Map([['n', ['Budget.xlsx']]]),
      find: (title) => [...files].map(([key, f]) => ({ key, name: f.name })).find((e) => e.name.toLowerCase() === title.toLowerCase()),
      folder: () => null,
      read: async (e) => files.get(e.key)!.bytes.slice().buffer,
      drawing: async () => null,
      write: async (e, bytes) => {
        files.set(e.key, { ...files.get(e.key)!, bytes });
        writes.push(e.key);
        return true;
      },
    },
    5,
  );
  return { files, writes, keeper };
}

test('saving a source updates the documents that depend on it, and only those, once editing pauses', async () => {
  const { files, writes, keeper } = await vault();
  assert.equal(await keeper.check('n'), true);
  assert.deepEqual(writes, ['n']);
  files.set('b', { name: 'Budget.xlsx', bytes: await budget(2500) });
  keeper.saved('b');
  keeper.saved('b');
  await new Promise((r) => setTimeout(r, 20));
  await keeper.flush();
  assert.deepEqual(writes, ['n', 'n']);
  const back = await WordDocument.read(files.get('n')!.bytes);
  assert.equal(paragraphText(back.body.find((b) => b.kind === 'paragraph') as Paragraph), 'So far: 3140.');
  // Saved again with nothing that the note shows changed: the note is not written.
  keeper.saved('b');
  await keeper.flush();
  assert.deepEqual(writes, ['n', 'n']);
  assert.equal(await keeper.mayHaveLive('n'), true);
  assert.equal(await keeper.mayHaveLive('o'), false);
});

test('the keeper says what shows a document, and what a document’s blocks read (for background updates)', async () => {
  const { keeper } = await vault();
  assert.deepEqual((await keeper.dependentsOfKeys(['b'])).map((e) => e.key), ['n']);
  assert.deepEqual(await keeper.dependentsOfKeys(['o']), []);
  assert.deepEqual((await keeper.sourcesOf({ key: 'n', name: 'Notes.docx' })).map((e) => e.key), ['b']);
  assert.deepEqual(await keeper.sourcesOf({ key: 'o', name: 'Other.docx' }), []);
});

test('a stored document with no live blocks is not rewritten', async () => {
  const bytes = await (await WordDocument.create()).write();
  assert.equal((await updateStoredLive(bytes, 'Empty.docx', async () => null)).bytes, null);
});

test('a Markdown note kept as uploaded is updated, and kept as the app keeps a saved note', async () => {
  const markdown = new TextEncoder().encode('This week:\n\n![[Meals.csv]]\n\nThat is all.\n');
  const csv = new TextEncoder().encode('Day,Calories\nMon,2100\nTue,1900\n');
  const { bytes } = await updateStoredLive(markdown, 'Plan.md', async () => ({ name: 'Meals.csv', bytes: csv }));
  assert.ok(bytes && isWdoc(bytes));
  const wdoc = await readWdoc(bytes);
  assert.equal(wdoc.manifest.lens, 'md');
  assert.match(documentToMarkdown(await WordDocument.read(wdoc.document!)), /<!-- golem:live Meals\.csv stamp=[0-9a-f]{8} -->\n\n\| Day \| Calories \|/);
});

test('a CSV kept with its layout is read as the file it holds', async () => {
  const csv = new TextEncoder().encode('Day,Calories\n');
  const kept = await delimitedWdoc(csv, 'csv', { columns: [[0, 80]] });
  assert.deepEqual(await sourceBytes(kept), csv);
  assert.deepEqual(await sourceBytes(csv), csv);
});

test('the index finds the links of a file kept as plain text', () => {
  const lines = textSegments(new TextEncoder().encode('See [[Plan|the plan]] and [x](doc:Notes#Top).\n![[Meals.csv#A1:B2]]\n<!-- golem:live Budget.xlsx#Total stamp=00ff00ff -->\n<div data-golem-live="Diagram.svg">\nnothing here\n'));
  assert.deepEqual(lines.map((l) => l.links ?? []), [['Plan', 'Notes'], ['Meals.csv'], ['Budget.xlsx'], ['Diagram.svg'], [], []]);
});

test('a plain embed of a workbook in Markdown becomes a live block, filled in when it is updated', async () => {
  const bytes = await budget();
  const document = await markdownToDocument('Costs:\n\n![[Budget.xlsx#Expenses]]\n\nTotal ![[Budget.xlsx#Total]] so far, see ![[map.png]].\n');
  assert.deepEqual(findLive(document).map((at) => [at.kind, at.tag.source]), [
    ['block', 'Budget.xlsx#Expenses'],
    ['inline', 'Budget.xlsx#Total'],
  ]);
  await updateLive(document, async () => ({ name: 'Budget.xlsx', bytes }));
  const markdown = documentToMarkdown(document);
  assert.match(markdown, /<!-- golem:live Budget\.xlsx#Expenses stamp=[0-9a-f]{8} -->\n\n\| Item \| Amount \|/);
  assert.match(markdown, /Total <!-- golem:live Budget\.xlsx#Total stamp=[0-9a-f]{8} -->2740<!-- \/golem:live --> so far, see !\[\[map\.png\]\]\./);
});

test('a live block not filled in yet is still found by the search index', async () => {
  const document = await markdownToDocument('![[Budget.xlsx#Expenses]]\n\n<!-- golem:live Meals.csv -->\n<!-- /golem:live -->\n');
  assert.deepEqual(Object.keys(buildIndex(paragraphSegments(document)).l), ['Budget.xlsx', 'Meals.csv']);
});

// --- Copy as Live Link -------------------------------------------------------------------------

import { liveAddress } from '../src/live/sheetAddress.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';

test('Copy as Live Link names a selection by its defined name when it has one, else by sheet and range', async () => {
  const book = await readWorkbook(await budget());
  assert.equal(liveAddress(book, 0, { r0: 0, c0: 0, r1: 2, c1: 1 }), 'Expenses');
  assert.equal(liveAddress(book, 0, { r0: 3, c0: 1, r1: 3, c1: 1 }), 'Total');
  assert.equal(liveAddress(book, 0, { r0: 1, c0: 0, r1: 2, c1: 1 }), 'Budget!A2:B3');
  book.sheets[0].name = 'Home budget';
  assert.equal(liveAddress(book, 0, { r0: 1, c0: 0, r1: 1, c1: 0 }), "'Home budget'!A2");
  // What it gives is read back to the same cells.
  assert.deepEqual(await sheetResult(await budget(), 'Budget!A2:B3'), { kind: 'table', rows: [['Rent', '2100'], ['Food', '640']], header: false, align: ['left', 'right'] });
});

// --- Read-only in the editor -------------------------------------------------------------------

import { deletedAround, livePartIn } from '../src/live/guard.ts';
import { paragraphsIn } from '@golemdocs/docx';

test('an edit that would change part of a live block is refused; one that takes the whole block away is not', async () => {
  const document = await markdownToDocument('Before\n\n<!-- golem:live Meals.csv stamp=1 -->\n\n| Day | Calories |\n| --- | ---: |\n| Mon | 2100 |\n\n<!-- /golem:live -->\n\nTotal <!-- golem:live Budget.xlsx#Total stamp=2 -->2740<!-- /golem:live --> so far.\n');
  const paragraphs = paragraphsIn(document.body);
  const before = paragraphs[0];
  const cell = paragraphs[1];
  const total = paragraphs.at(-1)!;
  const at = (paragraph: Paragraph, offset: number) => ({ paragraph, offset });
  const source = (start: ReturnType<typeof at>, end = start) => livePartIn(document.body, start, end)?.source ?? null;
  // Typing in a table cell of the block, or in the inline value, is refused; beside the value it is not.
  assert.equal(source(at(cell, 1)), 'Meals.csv');
  assert.equal(source(at(total, 8)), 'Budget.xlsx#Total');
  assert.equal(source(at(total, 6)), null);
  assert.equal(source(at(total, 10)), null);
  // A selection from before the block to after it takes it all; one ending inside it would take only part.
  assert.equal(source(at(before, 2), at(total, 3)), null);
  assert.equal(source(at(before, 2), at(cell, 1)), 'Meals.csv');
  assert.equal(source(at(total, 3), at(total, 12)), null);
  assert.equal(source(at(total, 3), at(total, 8)), 'Budget.xlsx#Total');
  // Backspace just after the inline value, or at the start of the paragraph after the table, reaches into a block.
  const backspace = (spot: ReturnType<typeof at>) => {
    const range = deletedAround(paragraphs, spot, 'backward');
    return range && livePartIn(document.body, range.start, range.end)?.source;
  };
  assert.equal(backspace(at(total, 10)), 'Budget.xlsx#Total');
  assert.equal(backspace(at(total, 6)), undefined);
  assert.equal(backspace(at(total, 0)), 'Meals.csv');
  assert.equal(deletedAround(paragraphs, at(before, 0), 'backward'), null);
});

// --- The out-of-date-on-open log -----------------------------------------------------------------

import { LiveCheckLog } from '../src/live/checkLog.ts';

test('opens are counted and sent in batches as totals, and only when signed in', () => {
  const sent: string[] = [];
  let signedIn = true;
  const log = new LiveCheckLog(() => signedIn, () => Date.UTC(2026, 10, 11), async (body) => sent.push(body));
  for (let i = 0; i < 20; i++) log.record(i % 4 === 0);
  assert.deepEqual(sent, ['{"opened":20,"stale":5}']);
  log.flush();
  assert.equal(sent.length, 1);
  log.record(true);
  signedIn = false;
  log.flush();
  log.flush();
  assert.equal(sent.length, 1);
  // The count ends on its date: nothing is counted or sent after it.
  const ended = new LiveCheckLog(() => true, () => Date.UTC(2027, 3, 1), async (body) => sent.push(body));
  for (let i = 0; i < 25; i++) ended.record(true);
  ended.flush();
  assert.equal(sent.length, 1);
});

// --- Text documents as sources -----------------------------------------------------------------

import { frontMatterField } from '../src/live/textSource.ts';
import { bookmarkStart, bookmarkEnd } from '@golemdocs/docx';

const para = (text: string, style?: string): Paragraph => ({ kind: 'paragraph', properties: style ? { style } : {}, children: text ? [{ kind: 'run', properties: {}, content: [{ kind: 'text', text }], attrs: {} }] : [], attrs: {} });

/** A report: a section on costs with a titled table, and a bookmarked paragraph. */
async function report(rent = '2100'): Promise<Uint8Array> {
  const doc = await WordDocument.create();
  const costs = await markdownToDocument(`| Item | Amount |\n| --- | ---: |\n| Rent | ${rent} |\n`);
  const table = costs.body.find((b): b is Table => b.kind === 'table')!;
  table.properties.caption = 'Costs';
  const marked = para('The plan holds.');
  marked.children.unshift(bookmarkStart('1', 'Verdict'));
  marked.children.push(bookmarkEnd('1'));
  doc.body = [para('Intro', 'Heading1'), para('Hello.'), para('Costs', 'Heading1'), para('We pay rent.'), table, para('Later', 'Heading1'), marked];
  return doc.write();
}

test('a text document gives a heading’s section, a bookmark, and a table by its title', async () => {
  const file: SourceFile = { name: 'Report.docx', bytes: await report() };
  const section = await produce(file, 'Costs');
  assert.equal(section.kind, 'blocks');
  if (section.kind === 'blocks') assert.deepEqual(section.blocks.map((b) => b.kind), ['paragraph', 'table']);
  const bookmark = await produce(file, 'Verdict');
  assert.ok(bookmark.kind === 'blocks' && bookmark.blocks.length === 1 && paragraphText(bookmark.blocks[0] as Paragraph) === 'The plan holds.');
  const table = await produce(file, 'table:Costs');
  assert.deepEqual(table, { kind: 'table', rows: [['Item', 'Amount'], ['Rent', '2100']], header: true, align: ['left', 'right'] });
  assert.deepEqual(await produce(file, 'Nowhere'), { kind: 'error', code: 'notFound', detail: 'Nowhere' });
  // The same part gives the same stamp; a change in it a new one.
  assert.equal(stampOf(await produce(file, 'Costs')), stampOf(section));
  assert.notEqual(stampOf(await produce({ name: 'Report.docx', bytes: await report('2500') }, 'Costs')), stampOf(section));
});

test('a section of one document fills a live block of another', async () => {
  const host = await WordDocument.create();
  host.body = [liveWrapper<Block>({ source: 'Report.docx#Costs', stamp: '' }, [para('')])];
  const bytes = await report();
  const report1 = await updateLive(host, async () => ({ name: 'Report.docx', bytes }));
  assert.equal(report1.updated, 1);
  const back = await WordDocument.read(await host.write());
  const [at] = findLive(back);
  assert.deepEqual(at.wrapper.children.map((b) => b.kind), ['paragraph', 'table']);
  assert.equal(paragraphText(at.wrapper.children[0] as Paragraph), 'We pay rent.');
});

test('a note’s front matter gives a field as a value', async () => {
  const fm = 'title: "Chapter 3"\nstatus: draft\ntags: [a, b]\nauthors:\n  - Ann\n  - Bo\n';
  assert.equal(frontMatterField(fm, 'status'), 'draft');
  assert.equal(frontMatterField(fm, 'Title'), 'Chapter 3');
  assert.equal(frontMatterField(fm, 'tags'), 'a, b');
  assert.equal(frontMatterField(fm, 'authors'), 'Ann, Bo');
  assert.equal(frontMatterField(fm, 'missing'), null);
  const note = new TextEncoder().encode(`---\n${fm}---\n\n# Chapter 3\n`);
  assert.deepEqual(await produce({ name: 'Chapter 3.md', bytes: note }, 'field:status'), { kind: 'value', text: 'draft' });
});

test('a block whose source shows the document it is in, directly or through another, says so and keeps its result', async () => {
  const one = await WordDocument.create();
  one.body = [liveWrapper<Block>({ source: 'Two.docx#Part', stamp: '' }, [para('kept')])];
  const two = await WordDocument.create();
  two.body = [para('Part', 'Heading1'), liveWrapper<Block>({ source: 'One.docx', stamp: '' }, [para('')])];
  const files = new Map([
    ['1', { name: 'One.docx', bytes: await one.write() }],
    ['2', { name: 'Two.docx', bytes: await two.write() }],
  ]);
  const problems: string[] = [];
  const entries = () => [...files].map(([key, f]) => ({ key, name: f.name }));
  const keeper = new LiveKeeper({
    entries,
    links: async () => new Map([['1', ['Two.docx']], ['2', ['One.docx']]]),
    find: (title) => entries().find((e) => e.name === title),
    folder: () => null,
    read: async (e) => files.get(e.key)!.bytes.slice().buffer,
    drawing: async () => null,
    write: async () => true,
    report: (_e, r) => problems.push(...r.problems.map((p) => p.code)),
  });
  assert.equal(await keeper.check('1'), false);
  assert.deepEqual(problems, ['cycle']);
});

test('the index keeps live blocks’ sources apart from other links', async () => {
  const lines = textSegments(new TextEncoder().encode('See [[Plan]] and ![[map.png]].\n![[Meals.csv#A1:B2]]\n![[Report#table:Costs]]\n<!-- golem:live Budget.xlsx#Total stamp=00ff00ff -->\n'));
  assert.deepEqual(lines.map((l) => l.live ?? []), [[], ['Meals.csv'], ['Report'], ['Budget.xlsx'], []]);
  const document = await note();
  const index = buildIndex(paragraphSegments(document));
  assert.deepEqual(Object.keys(index.s ?? {}), ['Budget.xlsx']);
});

import { livePartAddress } from '../src/live/partAddress.ts';

test('Copy as Live Link in a document names the titled table, the bookmark, or the section at the caret', async () => {
  const body = (await WordDocument.read(await report())).body;
  const paragraphs = (b: Block) => (b.kind === 'paragraph' ? [b] : b.kind === 'table' ? (b.rows[1].kind === 'row' && b.rows[1].cells[0].kind === 'cell' ? (b.rows[1].cells[0].children as Paragraph[]) : []) : []);
  const at = (i: number, offset = 0) => livePartAddress(body, { paragraph: paragraphs(body[i])[0], offset });
  assert.equal(at(0), 'Intro');
  assert.equal(at(3, 2), 'Costs');
  assert.equal(at(4), 'table:Costs');
  assert.equal(at(6, 3), 'Verdict');
  assert.equal(livePartAddress([para('No headings here.')], { paragraph: (para('x')), offset: 0 }), null);
});

// --- Charts as pictures --------------------------------------------------------------------------

import { chartResult, chartSvg } from '../src/live/chartSource.ts';
import { newChart } from '../src/sheet/charts/make.ts';

/** The budget workbook with a column chart of its expenses, titled when `title` is given. */
async function budgetWithChart(rent = 2100, title: string | null = 'Spending'): Promise<Uint8Array> {
  const { readWorkbook, loadSheet } = await import('../src/sheet/xlsx/read.ts');
  const book = await readWorkbook(await budget(rent));
  await loadSheet(book, 0);
  const sheet = book.sheets[0] as Worksheet;
  const chart = newChart(book, sheet, { r0: 0, c0: 0, r1: 2, c1: 1 }, 'column')!;
  chart.chart.title = title;
  sheet.charts.push(chart);
  sheet.dirty.layout = true;
  return writeWorkbook(book, { recalculate: false });
}

const fakePng = async (svg: string) => new TextEncoder().encode(svg.slice(0, 8));

test('a workbook gives a chart, by its title or its number, as an SVG picture with a PNG beside it', async () => {
  const bytes = await budgetWithChart();
  const found = await chartResult(bytes, 'Spending', fakePng);
  assert.equal(found.kind, 'picture');
  if (found.kind !== 'picture') return;
  assert.match(found.svg!, /^<svg [^>]*viewBox="0 0 [\d.]+ [\d.]+"/);
  assert.match(found.svg!, />Rent</);
  assert.ok(found.width > 0 && found.height > 0);
  assert.equal((await chartResult(bytes, 'Chart 1', fakePng)).kind, 'picture');
  assert.equal((await chartResult(bytes, 'Budget!Spending', fakePng)).kind, 'picture');
  assert.deepEqual(await chartResult(bytes, 'Other', fakePng), { kind: 'error', code: 'notFound', detail: 'Other' });
  // The same chart draws the same; a changed value draws differently.
  assert.equal((await chartResult(bytes, 'Spending', fakePng) as { svg: string }).svg, found.svg);
  assert.notEqual((await chartResult(await budgetWithChart(9000), 'Spending', fakePng) as { svg: string }).svg, found.svg);
});

test('a chart scene is written as one path per colour and its text, escaped', () => {
  const svg = chartSvg({ width: 10, height: 5, points: new Float32Array([0, 0, 1, 0, 0, 1, 2, 2, 3, 2, 2, 3]), colors: new Uint32Array([0xff0000, 0xff0000, 0xff0000, 0xff0000, 0xff0000, 0xff0000]), texts: [{ text: 'A & B', x: 5, y: 2, size: 9, color: 0, align: 'center', bold: true }] });
  assert.equal((svg.match(/<path /g) ?? []).length, 1);
  assert.match(svg, /fill="#ff0000" d="M0 0L1 0L0 1ZM2 2L3 2L2 3Z"/);
  assert.match(svg, /text-anchor="middle"[^>]*font-weight="bold">A &amp; B<\/text>/);
});

// --- Spreadsheets as hosts -----------------------------------------------------------------------

import { addSheetLive, sheetLiveRanges } from '../src/live/sheetRanges.ts';
import { segmentsFromBytes } from '../src/formats/docBytes.ts';

/** A workbook with a heading in A1 and a live range at B3 showing `source`. */
async function hostBook(source: string): Promise<Uint8Array> {
  const book = new Workbook();
  const sheet = new Worksheet('Plan', 1);
  book.sheets.push(sheet);
  sheet.grid.set(0, 0, Kind.String, book.strings.add('Meals'), 0);
  addSheetLive(book, 0, 2, 1, source);
  return writeWorkbook(book, { recalculate: false });
}

async function cellsOfBook(bytes: Uint8Array): Promise<{ rows: string[][]; ranges: { formula: string; stamp: string }[] }> {
  const { readWorkbook, loadSheet } = await import('../src/sheet/xlsx/read.ts');
  const { displayText } = await import('../src/sheet/format/display.ts');
  const book = await readWorkbook(bytes);
  await loadSheet(book, 0);
  const sheet = book.sheets[0] as Worksheet;
  const rows: string[][] = Array.from({ length: sheet.grid.rows }, () => Array<string>(sheet.grid.cols).fill(''));
  sheet.grid.columns.forEach((column, c) => column?.forEach(0, sheet.grid.rows, (r, kind, value, style) => (rows[r][c] = displayText(book, kind, value, style).text)));
  return { rows, ranges: sheetLiveRanges(book).map((l) => ({ formula: l.name.formula, stamp: l.tag.stamp })) };
}

test('a workbook’s live range is filled from its source, grows and shrinks with it, and is rewritten only when it changes', async () => {
  const csv = (text: string) => async () => ({ name: 'Meals.csv', bytes: new TextEncoder().encode(text) });
  const first = await updateStoredLive(await hostBook('Meals.csv'), 'Plan.xlsx', csv('Day,Calories\nMon,2100\nTue,1900\n'));
  assert.equal(first.report.updated, 1);
  const filled = await cellsOfBook(first.bytes!);
  assert.deepEqual(filled.rows, [['Meals', '', ''], ['', '', ''], ['', 'Day', 'Calories'], ['', 'Mon', '2100'], ['', 'Tue', '1900']]);
  assert.equal(filled.ranges[0].formula, 'Plan!$B$3:$C$5');
  assert.match(filled.ranges[0].stamp, /^[0-9a-f]{8}$/);
  // The same source again: nothing to write.
  assert.equal((await updateStoredLive(first.bytes!, 'Plan.xlsx', csv('Day,Calories\nMon,2100\nTue,1900\n'))).bytes, null);
  // Fewer rows: the old ones are cleared and the name follows.
  const second = await updateStoredLive(first.bytes!, 'Plan.xlsx', csv('Day,Calories\nMon,2500\n'));
  const shrunk = await cellsOfBook(second.bytes!);
  assert.deepEqual(shrunk.rows, [['Meals', '', ''], ['', '', ''], ['', 'Day', 'Calories'], ['', 'Mon', '2500']]);
  assert.equal(shrunk.ranges[0].formula, 'Plan!$B$3:$C$4');
});

test('a workbook’s live range that is given a picture says it can’t show one', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const { report } = await updateStoredLive(await hostBook('map.png'), 'Plan.xlsx', async () => ({ name: 'map.png', bytes: png }));
  assert.deepEqual(report.problems.map((p) => p.code), ['unsupported']);
});

test('the search index knows the sources of a workbook’s live ranges', async () => {
  const bytes = await hostBook('Meals.csv#A1:B2');
  const segments = await segmentsFromBytes(bytes.slice().buffer);
  assert.deepEqual(segments?.[0].live, ['Meals.csv']);
});

import { OpcPackage, el } from '@golemdocs/docx';
import { cellKey, externalTitle } from '../src/sheet/externals.ts';

/** A workbook whose B1 is `=[1]Budget!B2*2` and B2 `=SUM([Budget.xlsx]Budget!B2:B3)`, kept as `rent`×2 and `rent`+640. */
async function linkedBook(rent = 2100): Promise<Uint8Array> {
  const book = new Workbook();
  const sheet = new Worksheet('Summary', 1);
  book.sheets.push(sheet);
  sheet.grid.set(0, 0, Kind.String, book.strings.add('Rent ×2'), 0);
  sheet.grid.set(0, 1, Kind.Number, rent * 2, 0);
  sheet.grid.set(1, 1, Kind.Number, rent + 640, 0);
  sheet.grid.columns[1]!.setFormula(0, { text: '[1]Budget!B2*2', originRow: 0, originCol: 1, kind: 'normal', shared: -1 });
  sheet.grid.columns[1]!.setFormula(1, { text: 'SUM([1]Budget!B2:B3)', originRow: 1, originCol: 1, kind: 'normal', shared: -1 });
  const pkg = await OpcPackage.read(await writeWorkbook(book, { recalculate: false }));
  const workbookPart = 'xl/workbook.xml';
  const rels = await pkg.relationships(workbookPart);
  const rid = rels.add('http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink', 'xl/externalLinks/externalLink1.xml');
  const part = 'xl/externalLinks/externalLink1.xml';
  pkg.set(
    part,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><externalBook r:id="TARGET"><sheetNames><sheetName val="Budget"/></sheetNames><sheetDataSet><sheetData sheetId="0"><row r="2"><cell r="B2"><v>${rent}</v></cell></row><row r="3"><cell r="B3"><v>640</v></cell></row></sheetData></sheetDataSet></externalBook></externalLink>`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml',
  );
  const target = (await pkg.relationships(part)).add('http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath', 'file:///C:/Books/Budget.xlsx', true);
  pkg.set(part, (await pkg.text(part)).replace('TARGET', target));
  const root = await pkg.xml(workbookPart);
  const at = root.children.findIndex((c) => typeof c !== 'string' && c.name === 'sheets');
  root.children.splice(at + 1, 0, el('externalReferences', {}, [el('externalReference', { 'r:id': rid })]));
  pkg.set(workbookPart, root);
  return pkg.write();
}

async function summaryValues(bytes: Uint8Array): Promise<string[]> {
  return (await cellsOfBook(bytes)).rows.map((r) => r[1]);
}

test('a workbook keeps and recalculates what it reads from another workbook, and refreshes it when that one changes', async () => {
  const linked = await linkedBook();
  const book = await readWorkbook(linked);
  assert.equal(externalTitle(book.externals[0].target), 'Budget.xlsx');
  assert.deepEqual(book.externals[0].sheets, ['Budget']);
  // Recalculating reads the kept values rather than turning them into #REF!.
  const { Engine } = await import('../src/sheet/formula/engine.ts');
  const { loadSheet } = await import('../src/sheet/xlsx/read.ts');
  await loadSheet(book, 0);
  new Engine(book).recalculateAll();
  const sheet = book.sheets[0] as Worksheet;
  assert.equal(sheet.grid.columns[1]!.value(0), 4200);
  assert.equal(sheet.grid.columns[1]!.value(1), 2740);
  // The search index links the workbook to the one it reads.
  const segments = await segmentsFromBytes(linked, 'Summary.xlsx');
  assert.ok(segments[0].live?.includes('Budget.xlsx'));
  // The budget changes: the kept values, and the formulas reading them, follow.
  const lookup = async (title: string) => (title === 'Budget.xlsx' ? { name: 'Budget.xlsx', bytes: await budget(2500) } : null);
  const first = await updateStoredLive(linked, 'Summary.xlsx', lookup);
  assert.equal(first.report.updated, 1);
  const reread = await readWorkbook(first.bytes!);
  assert.equal(reread.externals[0].cells[0].get(cellKey(1, 1)), 2500);
  assert.deepEqual((await summaryValues(first.bytes!)).slice(0, 2), ['5000', '3140']);
  // Unchanged: nothing to write. Gone: said so, and the kept values stay.
  assert.equal((await updateStoredLive(first.bytes!, 'Summary.xlsx', lookup)).bytes, null);
  const gone = await updateStoredLive(first.bytes!, 'Summary.xlsx', async () => null);
  assert.equal(gone.bytes, null);
  assert.deepEqual(gone.report.problems.map((p) => p.code), ['missing']);
});

import { PdfDocument, applyFields, readFields } from '@golemdocs/pdf';
import type { FormField } from '@golemdocs/pdf';
import { WDOC_VERSION, writeWdoc } from '../src/formats/wdoc.ts';

/** A one-page PDF with a text field `Total` (showing `total`) and a check box `Paid`. */
async function returnPdf(total = '1,250'): Promise<Uint8Array> {
  const doc = PdfDocument.create();
  doc.addPage([600, 800]);
  applyFields(doc, [
    { id: 'n1', name: 'Total', kind: 'text', page: 0, rect: [100, 700, 300, 720], value: total },
    { id: 'n2', name: 'Paid', kind: 'checkbox', page: 0, rect: [100, 660, 112, 672], value: '', onState: 'Yes' },
  ]);
  return doc.save();
}

/** A PDF as the account keeps it once filled in: its original, and its fields beside it. */
async function storedPdf(original: Uint8Array, fields: FormField[]): Promise<Uint8Array> {
  return writeWdoc({ manifest: { version: WDOC_VERSION, lens: 'pdf', origin: 'pdf', pagesCurrent: true }, document: null, original, extensions: { pdf: { annotations: [], fields } } });
}

test('a PDF form field’s value is a live source, from the file or as filled in', async () => {
  const original = await returnPdf();
  assert.deepEqual(await produce({ name: 'Return.pdf', bytes: original }, 'field:total'), { kind: 'value', text: '1,250' });
  assert.deepEqual(await produce({ name: 'Return.pdf', bytes: original }, 'field:Missing'), { kind: 'error', code: 'notFound', detail: 'Missing' });
  const fields = readFields(PdfDocument.load(original)).map((f) => (f.name === 'Total' ? { ...f, value: '980' } : f));
  assert.deepEqual(await produce({ name: 'Return.pdf', bytes: await storedPdf(original, fields) }, 'field:Total'), { kind: 'value', text: '980' });
});

test('a PDF’s form fields are filled from live sources, and the vault’s file has the values written in', async () => {
  const original = await returnPdf('');
  const fields = readFields(PdfDocument.load(original)).map((f) =>
    f.name === 'Total' ? { ...f, live: liveTagText({ source: 'Budget.xlsx#Total', stamp: '' }) } : f.name === 'Paid' ? { ...f, live: liveTagText({ source: 'Budget.xlsx#B2', stamp: '' }) } : f,
  );
  const stored = await storedPdf(original, fields);
  // The index links the PDF to the workbook, so a change to it reaches the PDF.
  const segments = await segmentsFromBytes(stored);
  assert.deepEqual(segments?.[0].live, ['Budget.xlsx']);
  const lookup = async (title: string) => (title === 'Budget.xlsx' ? { name: 'Budget.xlsx', bytes: await budget(2500) } : null);
  const first = await updateStoredLive(stored, 'Return.pdf', lookup);
  assert.equal(first.report.updated, 2);
  const { readWdoc } = await import('../src/formats/wdoc.ts');
  const after = (await readWdoc(first.bytes!)).extensions.pdf!.fields!;
  assert.deepEqual(after.map((f) => [f.name, f.value]), [['Total', '3140'], ['Paid', 'Yes']]);
  assert.match(after[0].live!, / stamp=[0-9a-f]{8}$/);
  // Nothing changed: nothing written.
  assert.equal((await updateStoredLive(first.bytes!, 'Return.pdf', lookup)).bytes, null);
  // The file written to the vault has the values in it.
  const { annotatedPdf } = await import('../src/formats/pdfFile.ts');
  const wdoc = await readWdoc(first.bytes!);
  const file = await annotatedPdf(wdoc.original!, wdoc.extensions, async () => { throw new Error('no edits'); });
  assert.deepEqual(readFields(PdfDocument.load(file)).map((f) => f.value), ['3140', 'Yes']);
});

import { builtinResult } from '../src/live/builtins.ts';
import { builtinAddress, parseBuiltin } from '../src/live/builtinAddress.ts';
import type { SourceLookup } from '../src/live/sources.ts';

/** A folder of Markdown notes, as a source lookup sees it. */
function notesLookup(notes: Record<string, string>, folder = 'Characters'): SourceLookup {
  const file = (name: string) => ({ name, bytes: new TextEncoder().encode(notes[name]) });
  const lookup: SourceLookup = async (title) => (notes[title] !== undefined ? file(title) : notes[`${title}.md`] !== undefined ? file(`${title}.md`) : null);
  lookup.folder = async (path) => (path === folder ? Object.keys(notes).map(file) : null);
  return lookup;
}

const characters = {
  'Ann.md': '---\nrole: captain\nstatus: alive\nborn: 1990-04-02\n---\nAnn leads the crew through the storm.\n',
  'Bo.md': '---\nrole: cook\nstatus: missing\nborn: 1985\n---\nBo cooks.\n',
  'Cy.md': '---\nrole: pilot\nstatus: alive\n---\nCy flies the ship home safely.\n',
};

test('a built-in block’s address reads back what it was written from', () => {
  const address = builtinAddress('list', 'Novel/Characters', { columns: 'role, status', sort: '-role', where: '' });
  assert.equal(address, '@list:Novel/Characters?columns=role, status&sort=-role');
  const back = parseBuiltin(address)!;
  assert.equal(back.kind, 'list');
  assert.equal(back.target, 'Novel/Characters');
  assert.equal(back.options.get('columns'), 'role, status');
  assert.equal(parseBuiltin(builtinAddress('count', 'A&B', { of: 'notes' }))!.target, 'A&B');
  assert.equal(parseBuiltin('Budget.xlsx#Total'), null);
});

test('a folder list shows its notes with front matter columns, filtered and sorted', async () => {
  const lookup = notesLookup(characters);
  assert.deepEqual(await builtinResult('@list:Characters?columns=role,status', lookup), {
    kind: 'table',
    rows: [['Characters', 'role', 'status'], ['Ann', 'captain', 'alive'], ['Bo', 'cook', 'missing'], ['Cy', 'pilot', 'alive']],
    header: true,
    align: ['left', 'left', 'left'],
  });
  const alive = await builtinResult('@list:Characters?columns=role&where=status:alive&sort=-role', lookup);
  assert.deepEqual(alive.kind === 'table' && alive.rows, [['Characters', 'role'], ['Cy', 'pilot'], ['Ann', 'captain']]);
  assert.deepEqual(await builtinResult('@list:Nowhere', lookup), { kind: 'error', code: 'missing', detail: 'Nowhere' });
});

test('a count gives a folder’s notes or words, a document’s words, and a goal', async () => {
  const lookup = notesLookup(characters);
  assert.deepEqual(await builtinResult('@count:Characters?of=notes', lookup), { kind: 'value', text: '3' });
  assert.deepEqual(await builtinResult('@count:Characters?of=notes&where=status:alive', lookup), { kind: 'value', text: '2' });
  assert.deepEqual(await builtinResult('@count:Characters', lookup), { kind: 'value', text: '15' });
  assert.deepEqual(await builtinResult('@count:Ann?goal=50000', lookup), { kind: 'value', text: '7 / 50,000' });
});

test('a timeline puts dated notes in order, leaving out those with no date', async () => {
  const result = await builtinResult('@timeline:Characters?date=born&columns=role', notesLookup(characters));
  assert.deepEqual(result.kind === 'table' && result.rows, [['born', 'Characters', 'role'], ['1985', 'Bo', 'cook'], ['1990-04-02', 'Ann', 'captain']]);
});

test('a folder list in a note is kept up to date when a note in the folder changes', async () => {
  const encode = (s: string) => new TextEncoder().encode(s);
  const files = new Map<string, { name: string; bytes: Uint8Array; folder: string }>();
  for (const [name, text] of Object.entries(characters)) files.set(name, { name, bytes: encode(text), folder: 'Characters' });
  files.set('index', { name: 'Cast.md', bytes: encode('# Cast\n\n![[@list:Characters?columns=role]]\n'), folder: 'Characters' });
  const entries = () => [...files].map(([key, f]) => ({ key, name: f.name }));
  const writes: string[] = [];
  const keeper = new LiveKeeper(
    {
      entries,
      links: async () => new Map([['index', ['@list:Characters?columns=role']]]),
      find: (title) => entries().find((e) => e.name === title || e.name === `${title}.md`),
      folder: (path) => (path === 'Characters' ? entries().filter((e) => files.get(e.key)!.folder === 'Characters') : null),
      read: async (e) => files.get(e.key)!.bytes.slice().buffer,
      drawing: async () => null,
      write: async (e, bytes) => {
        files.set(e.key, { ...files.get(e.key)!, bytes });
        writes.push(e.key);
        return true;
      },
    },
    5,
  );
  const shown = async () => documentToMarkdown(await WordDocument.read((await readWdoc(files.get('index')!.bytes)).document!));
  assert.equal(await keeper.check('index'), true);
  // The note listing the folder is in it, but does not list itself.
  assert.match(await shown(), /\| Characters \| role \|\n\| --- \| --- \|\n\| Ann \| captain \|\n\| Bo \| cook \|\n\| Cy \| pilot \|/);
  files.set('Bo.md', { name: 'Bo.md', bytes: encode('---\nrole: chef\n---\nBo cooks.\n'), folder: 'Characters' });
  keeper.saved('Bo.md');
  await keeper.flush();
  assert.deepEqual(writes, ['index', 'index']);
  assert.match(await shown(), /\| Bo \| chef \|/);
});

import { queryTable } from '../src/live/tableQuery.ts';
import { readOptions } from '../src/live/builtinAddress.ts';
import { resultOf } from '../src/live/sources.ts';
import { sourceTitle } from '@golemdocs/docx';

const meals = 'Day,Meal,Calories\nMon,Soup,"1,900"\nTue,Pasta,2400\nWed,Salad,1500\nThu,Pizza,2600\n';

test('a table’s rows are filtered, sorted, cut down and their columns picked by the address’s options', async () => {
  const lookup = async () => ({ name: 'Meals.csv', bytes: new TextEncoder().encode(meals) });
  const rows = async (source: string) => {
    const result = await resultOf(source, lookup);
    return result.kind === 'table' ? result.rows : result;
  };
  assert.deepEqual(await rows('Meals.csv?where=Calories>2000&sort=-Calories'), [['Day', 'Meal', 'Calories'], ['Thu', 'Pizza', '2600'], ['Tue', 'Pasta', '2400']]);
  assert.deepEqual(await rows('Meals.csv?where=Calories<=1900;Meal~s&columns=Meal,Day'), [['Meal', 'Day'], ['Soup', 'Mon'], ['Salad', 'Wed']]);
  assert.deepEqual(await rows('Meals.csv?where=day:tue'), [['Day', 'Meal', 'Calories'], ['Tue', 'Pasta', '2400']]);
  assert.deepEqual(await rows('Meals.csv?sort=Meal&limit=2'), [['Day', 'Meal', 'Calories'], ['Tue', 'Pasta', '2400'], ['Thu', 'Pizza', '2600']]);
  // Nothing left: the heading stays.
  assert.deepEqual(await rows('Meals.csv?where=Day:Sun'), [['Day', 'Meal', 'Calories']]);
  assert.deepEqual(await rows('Meals.csv?sort=Price'), { kind: 'error', code: 'notFound', detail: 'Price' });
  // Picked columns keep their alignment.
  const picked = queryTable({ kind: 'table', rows: [['A', 'B'], ['x', '1']], header: true, align: ['left', 'right'] }, readOptions('columns=B'));
  assert.deepEqual(picked.kind === 'table' && picked.align, ['right']);
  // A table without a heading is named by letters.
  const plain = queryTable({ kind: 'table', rows: [['x', '1'], ['y', '2']], header: false, align: ['left', 'right'] }, readOptions('where=B>1'));
  assert.deepEqual(plain.kind === 'table' && plain.rows, [['y', '2']]);
});

test('an address’s options are no part of the title it names, and make a plain embed a live block', () => {
  assert.equal(sourceTitle('Meals.csv?where=Day:Mon'), 'Meals.csv');
  assert.equal(sourceTitle('Budget.xlsx#Expenses?sort=-Amount'), 'Budget.xlsx');
  assert.equal(sourceTitle('@list:Characters?columns=role'), '@list:Characters?columns=role');
  const lines = textSegments(new TextEncoder().encode('![[Meals.csv?where=Day:Mon]]\n'));
  assert.deepEqual(lines[0].live, ['Meals.csv']);
});

import { drawingLiveSources, fillGroup, liveGroup, updateStoredDrawing } from '../src/live/drawingHost.ts';
import { isStoredDrawing } from '../src/live/stored.ts';

const DRAWING = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">${inner}</svg>`;

test('a drawing’s live group is filled from its source, keeping its place, and its file is indexed', async () => {
  const svg = DRAWING('<rect x="0" y="0" width="10" height="10" fill="red"/><g data-golem-live="Budget.xlsx#Total" transform="translate(40 30)"><text x="5" y="20" font-size="12">old</text></g>');
  const bytes = new TextEncoder().encode(svg);
  assert.ok(await isStoredDrawing(bytes, 'Plan.svg'));
  assert.ok(!(await isStoredDrawing(bytes, 'Plan.txt')));
  assert.deepEqual(drawingLiveSources(svg), ['Budget.xlsx#Total']);
  // The index links the drawing to the workbook.
  assert.deepEqual((await segmentsFromBytes(bytes.slice().buffer))?.[0].live, ['Budget.xlsx']);
  const lookup = async (title: string) => (title === 'Budget.xlsx' ? { name: 'Budget.xlsx', bytes: await budget(2500) } : null);
  const first = await updateStoredDrawing(bytes, lookup);
  assert.equal(first.report.updated, 1);
  const out = new TextDecoder().decode(first.bytes!);
  assert.match(out, />3140</);
  assert.doesNotMatch(out, />old</);
  // Its place and style, and the rest of the drawing, are as they were.
  assert.match(out, /translate\(40/);
  assert.match(out, /font-size="12"|font-size:\s*12/);
  assert.match(out, /<rect/);
  assert.match(out, /data-golem-stamp="[0-9a-f]{8}"/);
  // Nothing changed: nothing written.
  assert.equal((await updateStoredDrawing(first.bytes!, lookup)).bytes, null);
  // A missing source is told, and the group keeps what it showed.
  const gone = await updateStoredDrawing(bytes, async () => null);
  assert.equal(gone.bytes, null);
  assert.equal(gone.report.problems[0].code, 'missing');
});

test('a live group shows a picture in the box it had, and text a line a row', () => {
  const group = liveGroup('Budget.xlsx#chart:Spending');
  fillGroup(group, { kind: 'picture', bytes: new Uint8Array([1, 2, 3]), width: 300, height: 200 }, 'aaaaaaaa');
  const image = group.children[0];
  assert.equal(image.kind, 'image');
  assert.equal(image.kind === 'image' && image.width, 300);
  if (image.kind === 'image') Object.assign(image, { x: 10, y: 20, width: 150, height: 100 });
  fillGroup(group, { kind: 'picture', bytes: new Uint8Array([4, 5, 6]), width: 300, height: 200 }, 'bbbbbbbb');
  const again = group.children[0];
  assert.ok(again.kind === 'image' && again.width === 150 && again.x === 10 && again.href.endsWith(btoa(String.fromCharCode(4, 5, 6))));
  assert.equal(group.attrs['data-golem-stamp'], 'bbbbbbbb');
  const table = liveGroup('Budget.xlsx#Sheet1!A1:B2');
  fillGroup(table, { kind: 'table', rows: [['Rent', '2100'], ['Food', '600']], header: false }, 'cccccccc');
  const text = table.children[0];
  assert.ok(text.kind === 'text');
  assert.deepEqual(text.kind === 'text' && text.runs.map((r) => r.text), ['Rent    2100', 'Food    600']);
});

import { newLiveExport } from '../src/live/pdfLive.ts';

test('a live PDF export is written again from its document when the document changes, and is indexed', async () => {
  let report = new TextEncoder().encode('first');
  let exports = 0;
  const lookup: SourceLookup = async (title) => (title === 'Report.docx' ? { name: 'Report.docx', bytes: report } : null);
  lookup.exportPdf = async (file) => {
    exports++;
    return new TextEncoder().encode(`%PDF of ${new TextDecoder().decode(file.bytes)}`);
  };
  const stored = await newLiveExport('Report.docx', new TextEncoder().encode('%PDF of first'), report);
  assert.deepEqual((await segmentsFromBytes(stored.slice().buffer))?.[0].live, ['Report.docx']);
  // Unchanged: nothing made.
  assert.equal((await updateStoredLive(stored, 'Report.pdf', lookup)).bytes, null);
  assert.equal(exports, 0);
  report = new TextEncoder().encode('second');
  const next = await updateStoredLive(stored, 'Report.pdf', lookup);
  assert.equal(next.report.updated, 1);
  const wdoc = await readWdoc(next.bytes!);
  assert.equal(new TextDecoder().decode(wdoc.original!), '%PDF of second');
  assert.match(wdoc.extensions.pdf!.export!, /^live:Report\.docx stamp=[0-9a-f]{8}$/);
  assert.equal((await updateStoredLive(next.bytes!, 'Report.pdf', lookup)).bytes, null);
  // The document gone: told, and the PDF stays as it was.
  const gone = await updateStoredLive(next.bytes!, 'Report.pdf', async () => null);
  assert.equal(gone.bytes, null);
  assert.equal(gone.report.problems[0].code, 'missing');
});

// --- Stop Updating -------------------------------------------------------------------------------

import { findLiveIn, liveIndexAt, unwrapLive } from '../src/live/liveMarks.ts';
import { removeSheetLive } from '../src/live/sheetRanges.ts';

test('Stop Updating turns the block at the caret into what it shows, leaving the others live', async () => {
  const document = await markdownToDocument('<!-- golem:live Meals.csv stamp=1 -->\n\n| Day | Calories |\n| --- | ---: |\n| Mon | 2100 |\n\n<!-- /golem:live -->\n\nTotal <!-- golem:live Budget.xlsx#Total stamp=2 -->2740<!-- /golem:live --> so far.\n');
  const paragraphs = paragraphsIn(document.body);
  const total = paragraphs.at(-1)!;
  // The caret's paragraph names the block; a block of another source there is not it.
  assert.equal(liveIndexAt(document.body, paragraphs[1], 'Meals.csv'), 0);
  assert.equal(liveIndexAt(document.body, total, 'Budget.xlsx#Total'), 1);
  assert.equal(liveIndexAt(document.body, total, 'Meals.csv'), -1);
  unwrapLive(findLiveIn(document.body)[1]);
  assert.equal(paragraphText(paragraphsIn(document.body).at(-1)!), 'Total 2740 so far.');
  assert.deepEqual(findLive(document).map((at) => at.tag.source), ['Meals.csv']);
  unwrapLive(findLiveIn(document.body)[0]);
  assert.equal(findLive(document).length, 0);
  assert.equal(paragraphsIn(document.body).map(paragraphText).join('|'), 'Day|Calories|Mon|2100|Total 2740 so far.');
});

test('Stop Updating in a workbook takes away the live range’s name and keeps its cells', () => {
  const book = new Workbook();
  book.sheets.push(new Worksheet('Plan', 1));
  addSheetLive(book, 0, 2, 1, 'Meals.csv');
  addSheetLive(book, 0, 8, 1, 'Budget.xlsx#Total');
  assert.equal(removeSheetLive(book, 0, 0, 0), false);
  assert.equal(removeSheetLive(book, 0, 2, 1), true);
  assert.deepEqual(sheetLiveRanges(book).map((l) => l.tag.source), ['Budget.xlsx#Total']);
});
