// PDF markup carried into reflowed text (src/formats/pdfMarkup.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentRanges, paragraphsIn, plainText, type Paragraph, type Run } from '@word/docx';
import { PageDrawing, PdfDocument, noteRect, quadsFor, type Annotation } from '../../pdf/src/index.ts';
import { markupToDocument } from '../src/formats/pdfMarkup.ts';
import { pdfToDocument } from '../src/formats/pdfImport.ts';
import { pageCharacters } from '../src/formats/pdfText.ts';

async function sample(): Promise<Uint8Array> {
  const doc = PdfDocument.create();
  const page = doc.addPage([400, 300]);
  const d = new PageDrawing(page, { origin: 'top-left' });
  const font = doc.standardFont('Helvetica');
  d.text('The first sentence is important.', 40, 50, { font, size: 12 });
  d.text('This one is struck out entirely.', 40, 90, { font, size: 12 });
  d.text('And the last line gets a note.', 40, 130, { font, size: 12 });
  d.finish();
  return doc.save();
}

/** User-space boxes of the characters [from, to) of the page's text. */
function boxOf(pdf: PdfDocument, from: number, to: number): [number, number, number, number] {
  const chars = pageCharacters(pdf, 0).slice(from, to);
  return [Math.min(...chars.map((c) => c.user[0])), Math.min(...chars.map((c) => c.user[1])), Math.max(...chars.map((c) => c.user[2])), Math.max(...chars.map((c) => c.user[3]))];
}

const runs = (p: Paragraph): Run[] => p.children.filter((i): i is Run => i.kind === 'run');

test('highlights, strikeouts and notes become formatting and comments', async () => {
  const bytes = await sample();
  const pdf = PdfDocument.load(bytes);
  const text = pageCharacters(pdf, 0).map((c) => c.text).join('');
  const at = (s: string) => text.indexOf(s);
  const important = at('important');
  const struck = at('This one');
  const last = at('And the last');
  const annotations: Annotation[] = [
    { id: 'h', page: 0, kind: 'highlight', ...quadsFor([boxOf(pdf, important, important + 9)]), color: [1, 1, 0.2], contents: 'Key point', author: 'Ada', modified: 'D:20260102030405Z' },
    { id: 's', page: 0, kind: 'strikeout', ...quadsFor([boxOf(pdf, struck, struck + 'This one is struck out entirely.'.length)]), color: [1, 0, 0], contents: '' },
    { id: 'n', page: 0, kind: 'note', rect: noteRect(18, boxOf(pdf, last, last + 3)[3]), quads: [], color: [1, 0.8, 0.2], contents: 'Check the ending', author: 'Bo' },
  ];
  const document = await pdfToDocument(bytes);
  markupToDocument(document, pdf, annotations);
  const paragraphs = paragraphsIn(document.body);
  const all = paragraphs.flatMap(runs);
  const highlighted = all.filter((r) => r.properties.highlight).map((r) => r.content.map((c) => ('text' in c ? c.text : '')).join('')).join('');
  assert.equal(highlighted, 'important');
  assert.equal(all.find((r) => r.properties.highlight)?.properties.highlight, 'yellow');
  const struckText = all.filter((r) => r.properties.strike).map((r) => r.content.map((c) => ('text' in c ? c.text : '')).join('')).join('');
  assert.equal(struckText, 'This one is struck out entirely.');
  // Two comments: the highlight's text and the note.
  assert.deepEqual(
    document.comments.map((c) => [c.author, c.paragraphs[0]]),
    [
      ['Ada', 'Key point'],
      ['Bo', 'Check the ending'],
    ],
  );
  assert.equal(document.comments[0].date, '2026-01-02T03:04:05Z');
  const ranges = commentRanges(paragraphs);
  const first = ranges.get(document.comments[0].id)!;
  assert.equal(plainText(first.start.paragraph, first.start.offset, first.end.offset), 'important');
  const note = ranges.get(document.comments[1].id)!;
  assert.match(plainText(note.start.paragraph, note.start.offset, note.end.offset), /^And the last line gets a/);
});

test('annotations whose text is not found are skipped', async () => {
  const bytes = await sample();
  const pdf = PdfDocument.load(bytes);
  const document = await pdfToDocument(bytes);
  const before = JSON.stringify(document.body);
  markupToDocument(document, pdf, [{ id: 'x', page: 0, kind: 'highlight', ...quadsFor([[300, 10, 390, 20]]), color: [1, 1, 0], contents: '' }]);
  assert.equal(JSON.stringify(document.body), before);
  assert.equal(document.comments.length, 0);
});
