// Tagged PDF export (pdfTags.ts): the structure tree of an exported document, with the text each element holds.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WordDocument, commentEnd, commentReference, commentStart, insertInlines, type Paragraph, type Run } from '@golemdocs/docx';
import { FontSet } from '@golemdocs/layout';
import { PdfDict, PdfDocument, PdfRef, PdfString, isName, type PdfObject } from '@golemdocs/pdf';
import { documentToPdf } from '../src/formats/pdfExport.ts';
import { markdownToDocument } from '../src/formats/markdown.ts';
import { documentLanguageTag } from '../src/formats/pdfTags.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
// No font files: text is set in the standard fonts, so its bytes read back as plain text.
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;
// With font files, as in the app: every face is embedded.
const withFiles = hasFonts
  ? await FontSet.load(
      async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8')),
      async (p) => new Uint8Array(readFileSync(path.join(FONT_DIR, p))),
    )
  : null;
/** veraPDF, the PDF/UA validator, where it is installed (`brew install verapdf`); its tests are skipped elsewhere. */
const verapdf = (() => {
  try {
    execFileSync('verapdf', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** The catalog's XMP metadata as text. */
const xmp = (doc: PdfDocument) => new TextDecoder().decode(doc.streamData(doc.catalog.get('Metadata')));

const run = (text: string): Run => ({ kind: 'run', properties: {}, content: [{ kind: 'text', text }], attrs: {} });
const paragraph = (children: Paragraph['children']): Paragraph => ({ kind: 'paragraph', properties: {}, children, attrs: {} });

/** The text drawn in each marked-content sequence of a page, by MCID; artifacts' text under -1. */
function markedText(doc: PdfDocument, pageIndex: number): Map<number, string> {
  const out = new Map<number, string>();
  const stack: number[] = [];
  for (const { op, operands } of doc.pages[pageIndex].operations()) {
    if (op === 'BDC') stack.push(isName(operands[0], 'Artifact') ? -1 : (doc.number((operands[1] as PdfDict).get('MCID')) ?? -2));
    else if (op === 'BMC') stack.push(isName(operands[0], 'Artifact') ? -1 : -2);
    else if (op === 'EMC') stack.pop();
    else if (op === 'TJ' || op === 'Tj') {
      const id = stack.length ? stack[stack.length - 1] : -3;
      const parts = op === 'TJ' ? (operands[0] as PdfObject[]) : operands;
      const text = parts.filter((p): p is PdfString => p instanceof PdfString).map((p) => p.binary).join('');
      out.set(id, (out.get(id) ?? '') + text);
    }
  }
  return out;
}

/** Painting operators on a page outside any marked content: PDF/UA wants everything either tagged or an artifact. */
function untagged(doc: PdfDocument, pageIndex: number): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const { op } of doc.pages[pageIndex].operations()) {
    if (op === 'BDC' || op === 'BMC') depth++;
    else if (op === 'EMC') depth--;
    else if (!depth && ['Tj', 'TJ', "'", '"', 'Do', 'f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*', 'sh', 'BI'].includes(op)) out.push(op);
  }
  return out;
}

/**
 * The structure tree as text: each element's type, then its content in order, the text of its marked content in
 * brackets and its child elements in parentheses, e.g. `Document(H1[Title] P[Body])` or `LBody[two](L(...))`.
 */
function outline(doc: PdfDocument): string {
  const root = doc.dict(doc.catalog.get('StructTreeRoot'))!;
  const pageIndex = new Map(doc.pages.map((p, i) => [p.ref.key, i]));
  const texts = doc.pages.map((_, i) => markedText(doc, i));
  // List bullets are left out: how they are encoded depends on the font.
  const clean = (text: string) => text.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
  const element = (ref: PdfObject): string => {
    const dict = doc.dict(ref)!;
    const type = (dict.get('S') as { name: string }).name;
    const page = dict.get('Pg');
    const kids = dict.get('K');
    const list = kids === undefined ? [] : Array.isArray(kids) ? kids : [kids];
    /** Runs of text and of child elements, in order. */
    const runs: (string | string[])[] = [];
    const text = (t: string) => {
      if (typeof runs[runs.length - 1] === 'string') runs[runs.length - 1] += t;
      else runs.push(t);
    };
    for (const kid of list) {
      if (typeof kid === 'number') text(texts[pageIndex.get((page as PdfRef).key)!].get(kid) ?? '');
      else if (kid instanceof PdfDict && isName(kid.get('Type'), 'MCR')) text(texts[pageIndex.get((kid.get('Pg') as PdfRef).key)!].get(doc.number(kid.get('MCID'))!) ?? '');
      else if (kid instanceof PdfDict && isName(kid.get('Type'), 'OBJR')) continue;
      else if (Array.isArray(runs[runs.length - 1])) (runs[runs.length - 1] as string[]).push(element(kid));
      else runs.push([element(kid)]);
    }
    return type + runs.map((r) => (typeof r === 'string' ? (clean(r) ? `[${clean(r)}]` : '') : `(${r.join(' ')})`)).join('');
  };
  return element(root.get('K')!);
}

test('headings, paragraphs, nested lists and tables are tagged in reading order', skip, async () => {
  const doc = await markdownToDocument(
    ['# Annual report', '', 'Some text.', '', '## Results', '', '- one', '- two', '  - nested', '- three', '', '1. first', '', '| Name | Age |', '| --- | --- |', '| Ann | 30 |', '', 'The end.'].join('\n'),
  );
  const back = PdfDocument.load(await documentToPdf(doc, fonts!));
  assert.equal(
    outline(back),
    'Document(H1[Annual report] P[Some text.] H2[Results] ' +
      'L(LI(LBody[one]) LI(LBody[two](L(LI(LBody[nested])))) LI(LBody[three])) L(LI(LBody[1. first])) ' +
      'Table(TR(TH(P[Name]) TH(P[Age])) TR(TD(P[Ann]) TD(P[30]))) P[The end.])',
  );
  // Table borders and list rules are drawn too, as artifacts.
  assert.deepEqual(untagged(back, 0), []);
});

test('the document is marked as tagged, with its language, and titled by its first heading', skip, async () => {
  const doc = await markdownToDocument('# Annual report\n\nThe quick brown fox jumps over the lazy dog and runs away.');
  const back = PdfDocument.load(await documentToPdf(doc, fonts!));
  const catalog = back.catalog;
  assert.equal(back.dict(catalog.get('MarkInfo'))?.get('Marked'), true);
  // A new document declares US English.
  assert.equal((catalog.get('Lang') as PdfString).binary, 'en-US');
  assert.equal(back.getMetadata('Title'), 'Annual report');
  assert.equal(back.dict(catalog.get('ViewerPreferences'))?.get('DisplayDocTitle'), true);
  // Every marked sequence on the page has its element in the parent tree.
  const page = back.pages[0];
  const key = page.dict.get('StructParents');
  const nums = back.array(back.dict(back.dict(catalog.get('StructTreeRoot'))!.get('ParentTree'))!.get('Nums'))!;
  const owners = back.array(nums[nums.indexOf(key!) + 1])!;
  assert.equal(owners.length, markedText(back, 0).size);
  assert.ok(owners.every((o) => o instanceof PdfRef));
});

test('headers and footers are artifacts, and a picture is a Figure with its description', skip, async () => {
  const doc = await WordDocument.create();
  const header = doc.addHeaderFooter('header');
  header.children = [paragraph([run('Running head')])];
  doc.section.headers.push({ type: 'default', part: header.part });
  const png = readFileSync(path.resolve(import.meta.dirname, '../../pdf/test/fixtures/img-rgb.png'));
  const image = doc.addImage(new Uint8Array(png), 'png');
  const picture: Run = { kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'drawing', inline: true, width: 914400, height: 914400, image, description: 'A red square' }] };
  doc.body = [paragraph([run('Body text')]), paragraph([picture])];
  const back = PdfDocument.load(await documentToPdf(doc, fonts!));
  assert.equal(outline(back), 'Document(P[Body text] P(Figure))');
  assert.equal(markedText(back, 0).get(-1), 'Running head');
  assert.deepEqual(untagged(back, 0), []);
  const figure = (() => {
    const find = (ref: PdfObject): PdfDict | undefined => {
      const dict = back.dict(ref);
      if (!dict) return undefined;
      if (isName(dict.get('S'), 'Figure')) return dict;
      const k = dict.get('K');
      for (const kid of Array.isArray(k) ? k : k === undefined ? [] : [k]) {
        const found = find(kid);
        if (found) return found;
      }
      return undefined;
    };
    return find(back.dict(back.catalog.get('StructTreeRoot'))!.get('K')!)!;
  })();
  assert.equal((figure.get('Alt') as PdfString).text, 'A red square');
});

test('a table header row repeated on the next page is an artifact', skip, async () => {
  const rows = Array.from({ length: 80 }, (_, i) => `| Row ${i} | ${i} |`);
  const doc = await markdownToDocument(['| Name | Value |', '| --- | --- |', ...rows].join('\n'));
  for (const block of doc.body) if (block.kind === 'table') for (const row of block.rows) if (row.kind === 'row') { row.properties.header = true; break; }
  const back = PdfDocument.load(await documentToPdf(doc, fonts!));
  assert.ok(back.pageCount >= 2);
  const tree = outline(back);
  assert.equal(tree.match(/TH\(P\[Name\]\)/g)?.length, 1, tree.slice(0, 200));
  assert.match(markedText(back, 1).get(-1) ?? '', /Name/);
});

test('the language is the declared one, else the text’s, else the app’s', async () => {
  const doc = await WordDocument.create();
  doc.styles.defaultRunProperties = { ...doc.styles.defaultRunProperties, lang: undefined };
  doc.body = [paragraph([run('Der schnelle braune Fuchs springt über den faulen Hund und die Katze.')])];
  assert.equal(documentLanguageTag(doc, 'fr'), 'de');
  doc.body = [paragraph([run('今日は良い天気ですね。')])];
  assert.equal(documentLanguageTag(doc, 'fr'), 'ja');
  doc.body = [paragraph([run('42')])];
  assert.equal(documentLanguageTag(doc, 'fr'), 'fr');
  doc.styles.defaultRunProperties = { ...doc.styles.defaultRunProperties, lang: { val: 'en_GB' } };
  assert.equal(documentLanguageTag(doc, 'fr'), 'en-GB');
});

test('comments are tagged as annotations, reached in structure order', skip, async () => {
  const doc = await WordDocument.create();
  const body = paragraph([run('A paragraph with a remark on it.')]);
  doc.body = [body];
  insertInlines(body, 12, [commentEnd('0'), commentReference('0')]);
  insertInlines(body, 0, [commentStart('0')]);
  doc.comments = [{ id: '0', author: 'Ada', paragraphs: ['Check this'] }];
  const back = PdfDocument.load(await documentToPdf(doc, fonts!));
  assert.equal(outline(back), 'Document(P[A paragraph with a remark on it.] Annot)');
  const page = back.pages[0];
  assert.ok(isName(page.dict.get('Tabs'), 'S'));
  // The note has its element in the parent tree; its popup has none.
  const nums = back.array(back.dict(back.dict(back.catalog.get('StructTreeRoot'))!.get('ParentTree'))!.get('Nums'))!;
  for (const annot of page.annotations) {
    const key = annot.get('StructParent');
    if (isName(annot.get('Subtype'), 'Popup')) assert.equal(key, undefined);
    else assert.ok(back.dict(nums[nums.indexOf(key!) + 1])?.get('S'), 'element for the note');
  }
});

test('a document with no title or heading is titled by its opening words', skip, async () => {
  const doc = await WordDocument.create();
  doc.body = [paragraph([]), paragraph([run('Minutes of the meeting held on the second of November, with the budget, the plan and more.')])];
  const back = PdfDocument.load(await documentToPdf(doc, fonts!));
  assert.equal(back.getMetadata('Title'), 'Minutes of the meeting held on the second of November, with');
  assert.match(xmp(back), /<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Minutes of the meeting/);
});

test('the PDF declares PDF/UA only when every font is embedded and every picture described', skip, async () => {
  const md = '# Report\n\nSome **bold** and *italic* text.';
  const embedded = PdfDocument.load(await documentToPdf(await markdownToDocument(md), withFiles!));
  assert.match(xmp(embedded), /<pdfuaid:part>1<\/pdfuaid:part>/);
  assert.match(xmp(embedded), /<dc:language><rdf:Bag><rdf:li>en-US<\/rdf:li>/);
  // Without font files the text is in standard fonts, which are not embedded.
  const standard = PdfDocument.load(await documentToPdf(await markdownToDocument(md), fonts!));
  assert.doesNotMatch(xmp(standard), /<pdfuaid:part>/);
  const doc = await WordDocument.create();
  const png = readFileSync(path.resolve(import.meta.dirname, '../../pdf/test/fixtures/img-rgb.png'));
  const image = doc.addImage(new Uint8Array(png), 'png');
  doc.body = [paragraph([run('Text')]), paragraph([{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'drawing', inline: true, width: 914400, height: 914400, image }] }])];
  assert.doesNotMatch(xmp(PdfDocument.load(await documentToPdf(doc, withFiles!))), /<pdfuaid:part>/);
});

test('veraPDF passes an export as PDF/UA-1', { ...skip, ...(!verapdf && { skip: 'veraPDF is not installed' }), timeout: 120000 }, async () => {
  const doc = await markdownToDocument(
    ['# Annual report', '', 'Some **bold** and *italic* text.', '', '- one', '  - nested', '- two', '', '1. first', '', '| Name | Age |', '| --- | --- |', '| Ann | 30 |'].join('\n'),
  );
  const header = doc.addHeaderFooter('header');
  header.children = [paragraph([run('Running head')])];
  doc.section.headers.push({ type: 'default', part: header.part });
  const body = doc.body[1] as Paragraph;
  insertInlines(body, 4, [commentEnd('0'), commentReference('0')]);
  insertInlines(body, 0, [commentStart('0')]);
  doc.comments = [{ id: '0', author: 'Ada', paragraphs: ['Check this'] }];
  const dir = mkdtempSync(path.join(tmpdir(), 'pdfua-'));
  try {
    const file = path.join(dir, 'export.pdf');
    writeFileSync(file, await documentToPdf(doc, withFiles!));
    let report: string;
    try {
      report = execFileSync('verapdf', ['-f', 'ua1', '--format', 'text', '-v', file], { encoding: 'utf8' });
    } catch (e) {
      report = String((e as { stdout?: string }).stdout ?? e);
    }
    assert.match(report, /^PASS /m, report);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
