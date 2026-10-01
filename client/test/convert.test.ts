import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WordDocument, type Paragraph, type Run } from '@golemdocs/docx';
import { FontSet } from '@golemdocs/layout';
import { PdfDocument } from '@golemdocs/pdf';
import { conversionIsLossy, convertContent, readDocument, writeDocument, type OpenContent } from '../src/formats/convert.ts';
import { documentToMarkdown } from '../src/formats/markdown.ts';
import { documentToText } from '../src/formats/plainText.ts';
import { sourceFromFile, stem } from '../src/formats/source.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

const run = (text: string, properties: Run['properties'] = {}): Run => ({ kind: 'run', properties, content: [{ kind: 'text', text }], attrs: {} });
const paragraph = (children: Paragraph['children'], properties: Paragraph['properties'] = {}): Paragraph => ({ kind: 'paragraph', properties, children, attrs: {} });
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

async function sample(): Promise<WordDocument> {
  const doc = await WordDocument.create();
  doc.body = [
    paragraph([run('Quarterly report')], { style: 'Heading1' }),
    paragraph([run('Revenue grew '), run('strongly', { bold: true }), run(' and costs were '), run('flat', { italic: true, color: { val: 'FF0000' } }), run('.')]),
    paragraph([run('Second paragraph of body text that is long enough to be a real paragraph in the output.')]),
  ];
  return doc;
}

test('Word to Markdown keeps structure and emphasis, drops color', async () => {
  const doc = await sample();
  const md = decode(await writeDocument(doc, 'md', fonts!));
  assert.match(md, /^# Quarterly report/m);
  assert.match(md, /\*\*strongly\*\*/);
  assert.match(md, /\*flat\*/);
  assert.doesNotMatch(md, /FF0000/i);
  // Reading it back as Markdown gives a document with the same structure.
  const back = await readDocument('md', new TextEncoder().encode(md));
  assert.equal(documentToMarkdown(back), documentToMarkdown(doc));
});

test('Word to text keeps only the words', async () => {
  const doc = await sample();
  const txt = decode(await writeDocument(doc, 'txt', fonts!));
  assert.match(txt, /^Quarterly report\nRevenue grew strongly and costs were flat\./);
  const back = await readDocument('txt', new TextEncoder().encode(txt));
  assert.equal(documentToText(back), txt);
});

test('Markdown and text go up to Word without loss', async () => {
  const md = await readDocument('md', new TextEncoder().encode('# Title\n\nSome **bold** text.\n\n- one\n- two\n'));
  const docx = await convertContent({ format: 'md', document: md }, 'docx', fonts!);
  const reread = await WordDocument.read(docx);
  assert.equal(documentToMarkdown(reread), documentToMarkdown(md));
  assert.equal(conversionIsLossy('md', 'docx'), false);
  assert.equal(conversionIsLossy('txt', 'md'), false);
  assert.equal(conversionIsLossy('docx', 'md'), true);
  assert.equal(conversionIsLossy('pdf', 'docx'), true);
});

test('Word to PDF and back to Word recovers the text', skip, async () => {
  const doc = await sample();
  const pdf = await convertContent({ format: 'docx', document: doc }, 'pdf', fonts!);
  assert.ok(PdfDocument.load(pdf).pageCount >= 1);
  const docx = await convertContent({ format: 'pdf', bytes: pdf }, 'docx', fonts!);
  const back = await WordDocument.read(docx);
  assert.equal(norm(documentToText(back)), norm(documentToText(doc)));
  // A PDF converts to the other text formats too, and to itself unchanged.
  const md = decode(await convertContent({ format: 'pdf', bytes: pdf }, 'md', fonts!));
  assert.match(md, /Revenue grew/);
  const same = await convertContent({ format: 'pdf', bytes: pdf }, 'pdf', fonts!);
  assert.deepEqual(same, pdf);
});

test('every format converts to every other from one Word document', skip, async () => {
  const content: OpenContent = { format: 'docx', document: await sample() };
  for (const to of ['docx', 'pdf', 'md', 'txt'] as const) {
    const bytes = await convertContent(content, to, fonts!);
    assert.ok(bytes.length > 20, to);
  }
});

test('files open as the format their extension names', () => {
  const bytes = new ArrayBuffer(0);
  assert.equal(sourceFromFile('a.DOCX', bytes)?.kind, 'docx');
  assert.equal(sourceFromFile('a.pdf', bytes)?.kind, 'pdf');
  assert.equal(sourceFromFile('a.md', bytes)?.kind, 'md');
  assert.equal(sourceFromFile('a.markdown', bytes)?.kind, 'md');
  assert.equal(sourceFromFile('a.txt', bytes)?.kind, 'txt');
  assert.equal(sourceFromFile('a.rtf', bytes)?.kind, 'rtf');
  assert.equal(sourceFromFile('a.doc', bytes)?.kind, 'doc');
  assert.equal(sourceFromFile('a.wpd', bytes), null);
  assert.equal(stem('Report.final.pdf'), 'Report.final');
});
