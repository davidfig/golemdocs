// Renaming or moving the source of a live block (docs/live-blocks.md, *Renaming a source*): the live blocks kept outside a
// document's text (a workbook's live ranges, a PDF's fields, text boxes and live export) and built-in blocks naming a folder
// (`@list:Vault/Characters`) are rewritten, `by=` and the stamp kept, and the search index lists them so a rename finds them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument, ZipArchive, folderRenameKey, renamedSource } from '@golemdocs/docx';
import type { Block } from '@golemdocs/docx';
import type { FormField, PdfEdit } from '@golemdocs/pdf';
import type { Folder } from '../src/folders.ts';
import { rewriteDocumentLinks, rewriteTextLinks } from '../src/formats/docLinks.ts';
import { segmentsFromBytes } from '../src/formats/docBytes.ts';
import { WDOC_VERSION, readWdoc, writeWdoc } from '../src/formats/wdoc.ts';
import { afterChange, anyFolderMoved, folderRetargets, mergeRetargets, placedDocs, retargets, type LibrarySnapshot } from '../src/linkRename.ts';
import { findLive, liveWrapper } from '../src/live/liveMarks.ts';
import { newLiveExport } from '../src/live/pdfLive.ts';
import { addSheetLive, sheetLiveRanges } from '../src/live/sheetRanges.ts';
import { Kind } from '../src/sheet/model/column.ts';
import { Workbook } from '../src/sheet/model/workbook.ts';
import { Worksheet } from '../src/sheet/model/worksheet.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';
import { writeWorkbook } from '../src/sheet/xlsx/write.ts';

const BY = '0123456789abcdef01234567';
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

/** A workbook with a sheet of text and live ranges showing `sources`, each made by BY. */
async function workbookShowing(...sources: string[]): Promise<Uint8Array> {
  const book = new Workbook();
  const sheet = new Worksheet('Summary', 1);
  book.sheets.push(sheet);
  sheet.grid.set(0, 0, Kind.String, book.strings.add('Heading'), 0);
  sources.forEach((source, i) => addSheetLive(book, 0, 2 + i * 5, 0, source, BY));
  book.names.push({ name: 'Other', formula: 'Summary!$A$1' });
  return writeWorkbook(book, { recalculate: false });
}

// --- renamedSource: built-in blocks' folders --------------------------------------------------------------------------------------

test('a built-in block naming a renamed folder is rewritten, options, by= and stamp kept', () => {
  const renames = new Map([[folderRenameKey('Vault/Characters'), 'Vault/Cast']]);
  assert.equal(renamedSource(`@list:Vault/Characters?columns=role by=${BY} stamp=0a0b0c0d`, renames), `@list:Vault/Cast?columns=role by=${BY} stamp=0a0b0c0d`);
  assert.equal(renamedSource('@timeline:Vault/Characters?date=born', renames), '@timeline:Vault/Cast?date=born');
  assert.equal(renamedSource('@count:Vault/Characters', renames), '@count:Vault/Cast');
  // Another folder, and a document link of the same name, are left alone.
  assert.equal(renamedSource('@list:Vault/Places', renames), null);
  assert.equal(renamedSource('Vault/Characters', renames), null);
});

test("a built-in block's new folder is escaped as builtinAddress writes it, and an escaped one is read", () => {
  const renames = new Map([[folderRenameKey('A&B'), 'C?D #1']]);
  assert.equal(renamedSource('@list:A%26B?columns=role', renames), '@list:C%3FD %231?columns=role');
});

test("a count of a document follows the document's rename before any folder of that name", () => {
  const renames = new Map([
    ['Novel.docx', 'Book.docx'],
    [folderRenameKey('Novel.docx'), 'Elsewhere'],
  ]);
  assert.equal(renamedSource('@count:Novel.docx?of=words', renames), '@count:Book.docx?of=words');
});

// --- folderRetargets: which documents' built-in blocks a folder rename or move rewrites -------------------------------------------

const folder = (id: string, name: string, parentId: string | null): Folder => ({ id, name, parentId, createdAt: 0, updatedAt: 0 });

function library(): LibrarySnapshot {
  return {
    folders: [folder('v', 'Vault', null), folder('c', 'Characters', 'v'), folder('s', 'Sub', 'c'), folder('p', 'Places', 'v'), folder('n', 'Notes', null)],
    docs: [
      { key: 'hero', name: 'Hero.md', folderId: 'c' },
      { key: 'index', name: 'Index.md', folderId: 'n' },
      { key: 'local', name: 'Local.md', folderId: 'v' },
      { key: 'doc', name: 'Characters.md', folderId: 'n' },
    ],
  };
}

test('renaming a folder rewrites the built-in blocks naming it and the folders in it, and only those', () => {
  const before = library();
  const after = afterChange(before, { kind: 'folders', changes: [{ id: 'c', name: 'Cast' }] });
  assert.ok(anyFolderMoved(before, after));
  const links = new Map([
    ['index', ['@list:Vault/Characters?columns=role', '@timeline:Vault/Characters/Sub?date=born', '@list:Vault/Places', 'Characters']],
    ['local', ['@list:Characters', 'Vault/Characters']],
  ]);
  const plan = folderRetargets(before, after, links);
  assert.deepEqual([...plan.get('index')!], [
    [folderRenameKey('Vault/Characters'), 'Vault/Cast'],
    [folderRenameKey('Vault/Characters/Sub'), 'Vault/Cast/Sub'],
  ]);
  // Written relative to the linking document's folder (Vault), as it was; a count's folder (listed alone) too.
  assert.deepEqual([...plan.get('local')!], [
    [folderRenameKey('Characters'), 'Cast'],
    [folderRenameKey('Vault/Characters'), 'Vault/Cast'],
  ]);
});

test('moving a folder rewrites a path that no longer finds it, and leaves one that still does', () => {
  const before = library();
  const after = afterChange(before, { kind: 'folders', changes: [{ id: 'c', parentId: 'n' }] });
  const plan = folderRetargets(before, after, new Map([['index', ['@list:Vault/Characters', '@list:Characters', '@list:/Vault/Characters/Sub']]]));
  // `Characters` is the only folder of that name, so it still finds it; the others name where it was.
  assert.deepEqual([...plan.get('index')!], [
    [folderRenameKey('Vault/Characters'), 'Notes/Characters'],
    [folderRenameKey('/Vault/Characters/Sub'), '/Notes/Characters/Sub'],
  ]);
});

test('a count of a document is not taken for a folder', () => {
  const before = library();
  before.folders.push(folder('x', 'Characters.md', 'n'));
  const after = afterChange(before, { kind: 'folders', changes: [{ id: 'x', name: 'Other' }] });
  // `Characters.md` names the document beside the folder: a count reads the document.
  assert.equal(folderRetargets(before, after, new Map([['index', ['Characters.md']]])).size, 0);
});

test("a folder rename's plan rewrites a Markdown note's built-in blocks with its document links", () => {
  const before = library();
  const after = afterChange(before, { kind: 'folders', changes: [{ id: 'c', name: 'Cast' }] });
  const text = `See [[Vault/Characters/Hero]].\n\n<!-- golem:live @list:Vault/Characters?columns=role by=${BY} stamp=12345678 -->\n\n| a |\n\n<!-- /golem:live -->\n\n![[@count:Vault/Characters/Sub]]\n`;
  const links = new Map([['index', ['Vault/Characters/Hero', '@list:Vault/Characters?columns=role', 'Vault/Characters/Sub']]]);
  const plan = mergeRetargets(retargets(placedDocs(before), placedDocs(after), links), folderRetargets(before, after, links));
  const { text: out, changed } = rewriteTextLinks(text, plan.get('index')!);
  assert.equal(changed, 3);
  assert.match(out, /\[\[Vault\/Cast\/Hero\]\]/);
  assert.match(out, new RegExp(`<!-- golem:live @list:Vault/Cast\\?columns=role by=${BY} stamp=12345678 -->`));
  assert.match(out, /!\[\[@count:Vault\/Cast\/Sub\]\]/);
});

test("a Word document's built-in block follows its folder's rename", async () => {
  const document = await WordDocument.create();
  document.body = [liveWrapper<Block>({ source: '@list:Vault/Characters?columns=role', stamp: 'aa', by: BY }, [])];
  const { bytes, changed } = await rewriteDocumentLinks(buffer(await document.write()), new Map([[folderRenameKey('Vault/Characters'), 'Vault/Cast']]));
  assert.equal(changed, 1);
  const tag = findLive(await WordDocument.read(bytes!))[0].tag;
  assert.deepEqual(tag, { source: '@list:Vault/Cast?columns=role', stamp: 'aa', by: BY });
});

// --- Workbooks ----------------------------------------------------------------------------------------------------------------------

test("renaming a source rewrites a workbook's live ranges, by= kept, and leaves the rest of the file as it was", async () => {
  const bytes = await workbookShowing('Budget.xlsx#Expenses', 'Other.xlsx#Total', '@list:Vault/Characters');
  const { bytes: next, changed } = await rewriteDocumentLinks(buffer(bytes), new Map([['Budget.xlsx', 'Money.xlsx'], [folderRenameKey('Vault/Characters'), 'Vault/Cast']]));
  assert.equal(changed, 2);
  const book = await readWorkbook(next!, { structureOnly: true });
  assert.deepEqual(
    sheetLiveRanges(book).map((l) => l.tag),
    [
      { source: 'Money.xlsx#Expenses', stamp: '', by: BY },
      { source: 'Other.xlsx#Total', stamp: '', by: BY },
      { source: '@list:Vault/Cast', stamp: '', by: BY },
    ],
  );
  assert.ok(book.names.some((n) => n.name === 'Other' && n.formula === 'Summary!$A$1'));
  // Every part but the workbook's is copied as it was, in the same order.
  const before = ZipArchive.read(bytes);
  const after = ZipArchive.read(next!);
  assert.deepEqual([...after.entries.keys()], [...before.entries.keys()]);
  for (const [name, entry] of before.entries) if (name !== 'xl/workbook.xml') assert.deepEqual(after.entries.get(name)!.raw, entry.raw, name);
});

test('a workbook with no live range naming a renamed source is left alone', async () => {
  const bytes = await workbookShowing('Other.xlsx#Total');
  assert.deepEqual(await rewriteDocumentLinks(buffer(bytes), new Map([['Budget.xlsx', 'Money.xlsx']])), { bytes: null, changed: 0 });
});

test("a workbook's index lists its live ranges' sources as a rename sees them", async () => {
  const segments = await segmentsFromBytes(buffer(await workbookShowing('Budget.xlsx#Expenses', '@count:Novel.docx?of=words', '@list:Vault/Characters?columns=role')));
  const line = segments![0];
  assert.deepEqual(line.live, ['Budget.xlsx', '@count:Novel.docx?of=words', '@list:Vault/Characters?columns=role']);
  assert.deepEqual(line.links, ['Budget.xlsx', 'Novel.docx', '@list:Vault/Characters?columns=role']);
});

// --- PDFs ---------------------------------------------------------------------------------------------------------------------------

const PDF = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');

function field(name: string, live?: string): FormField {
  return { id: name, name, kind: 'text', page: 0, rect: [0, 0, 100, 20], value: '', ...(live && { live }) };
}

test("renaming a source rewrites a PDF's live fields, text boxes and pictures, by= and stamp kept", async () => {
  const edits = [
    { id: 't1', page: 0, kind: 'textbox', box: [0, 0, 100, 50], text: '5', font: 'Helvetica', size: 12, color: [0, 0, 0], live: `live:Budget.xlsx#Total by=${BY} stamp=11111111` },
    { id: 'i1', page: 0, kind: 'image', box: [0, 0, 100, 50], data: '', live: 'live:Budget.xlsx#chart:Spend stamp=22222222' },
  ] as unknown as PdfEdit[];
  const stored = await writeWdoc({
    manifest: { version: WDOC_VERSION, lens: 'pdf', origin: 'pdf', pagesCurrent: true },
    document: null,
    original: PDF,
    extensions: { pdf: { annotations: [], fields: [field('Total', `live:Budget.xlsx#Total by=${BY} stamp=33333333`), field('Name'), field('Rate', 'live:Rates.xlsx#Rate')], edits } },
  });
  const { bytes, changed } = await rewriteDocumentLinks(buffer(stored), new Map([['Budget.xlsx', 'Money.xlsx']]));
  assert.equal(changed, 3);
  const pdf = (await readWdoc(bytes!)).extensions.pdf!;
  assert.deepEqual(pdf.fields!.map((f) => f.live), [`live:Money.xlsx#Total by=${BY} stamp=33333333`, undefined, 'live:Rates.xlsx#Rate']);
  assert.deepEqual(pdf.edits!.map((e) => ('live' in e ? e.live : undefined)), [`live:Money.xlsx#Total by=${BY} stamp=11111111`, 'live:Money.xlsx#chart:Spend stamp=22222222']);
});

test("renaming a document rewrites the tag of its Live PDF Copy, and the copy's index lists it", async () => {
  const stored = await newLiveExport('Report.docx', PDF, new Uint8Array([1, 2, 3]), BY);
  const segments = await segmentsFromBytes(buffer(stored));
  assert.deepEqual(segments![0].links, ['Report.docx']);
  const { bytes, changed } = await rewriteDocumentLinks(buffer(stored), new Map([['Report.docx', 'Annual Report.docx']]));
  assert.equal(changed, 1);
  const wdoc = await readWdoc(bytes!);
  assert.match(wdoc.extensions.pdf!.export!, new RegExp(`^live:Annual Report\\.docx by=${BY} stamp=[0-9a-f]{8}$`));
  assert.deepEqual(wdoc.original, PDF);
});

test("a PDF's index lists its live fields' sources as a rename sees them", async () => {
  const stored = await writeWdoc({
    manifest: { version: WDOC_VERSION, lens: 'pdf', origin: 'pdf', pagesCurrent: true },
    document: null,
    original: PDF,
    extensions: { pdf: { annotations: [], fields: [field('Words', 'live:@count:Novel.docx?of=words stamp=1'), field('Total', 'live:Budget.xlsx#Total')] } },
  });
  const line = (await segmentsFromBytes(buffer(stored)))![0];
  assert.deepEqual(line.links, ['Novel.docx', 'Budget.xlsx']);
  assert.deepEqual(line.live, ['@count:Novel.docx?of=words', 'Budget.xlsx']);
});
