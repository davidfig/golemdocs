// PDF import: PDFs made with the pdf package's writer, imported into the document model.
// Run: node --experimental-transform-types --test test/pdfImport.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WordDocument, type Paragraph, type Run } from '@word/docx';
import { PageDrawing, PdfDocument, PasswordError, type PdfFont } from '../../pdf/src/index.ts';
import { pdfToDocument, wordFontFor } from '../src/formats/pdfImport.ts';

const text = (p: Paragraph): string =>
  p.children
    .filter((c): c is Run => c.kind === 'run')
    .flatMap((r) => r.content)
    .map((c) => (c.kind === 'text' ? c.text : ''))
    .join('');
const paragraphs = (doc: WordDocument): Paragraph[] => doc.body.filter((b): b is Paragraph => b.kind === 'paragraph');
const runs = (p: Paragraph): Run[] => p.children.filter((c): c is Run => c.kind === 'run');

function wrap(s: string, font: PdfFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of s.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && PageDrawing.measure(next, { font, size }) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const BODY = 'Quiet rivers carry copper lanterns past the marble harbor while violet windows watch the meadow and the ember garden glows';

async function samplePdf(): Promise<Uint8Array> {
  const pdf = PdfDocument.create();
  const regular = pdf.standardFont('Times-Roman');
  const bold = pdf.standardFont('Times-Bold');
  const italic = pdf.standardFont('Times-Italic');
  const sans = pdf.standardFont('Helvetica');
  const d = pdf.addPage([595, 842]).draw({ origin: 'top-left' });
  const o = { font: regular, size: 11 };
  d.text('Field Notes', 72, 100, { font: bold, size: 24 });
  let y = 140;
  const para = (s: string) => {
    for (const line of wrap(s, regular, 11, 380)) {
      d.text(line, 72, y, o);
      y += 14;
    }
    y += 8;
  };
  para(BODY + '.');
  d.text('Observations', 72, y + 6, { font: bold, size: 16 });
  y += 30;
  // Mixed styles on one baseline.
  let x = 72;
  for (const [s, font] of [['Notes may be ', regular], ['bold', bold], [' or ', regular], ['italic', italic], ['.', regular]] as [string, PdfFont][]) {
    d.text(s, x, y, { font, size: 11 });
    x += PageDrawing.measure(s, { font, size: 11 });
  }
  y += 22;
  for (const item of ['First finding here', 'Second finding here']) {
    d.text('•', 72, y, o);
    d.text(item, 90, y, o);
    y += 14;
  }
  y += 8;
  for (const [n, item] of [['1.', 'Collect the samples'], ['2.', 'Label every jar'], ['3.', 'Write it all down']]) {
    d.text(n, 72, y, o);
    d.text(item, 90, y, o);
    y += 14;
  }
  y += 8;
  d.text('Set in sans-serif.', 72, y, { font: sans, size: 11 });
  d.finish();
  return pdf.save();
}

test('a PDF becomes headings, paragraphs with styled runs, real lists and the PDF page setup', async () => {
  const doc = await pdfToDocument(await samplePdf());
  const ps = paragraphs(doc);
  assert.deepEqual(
    ps.map((p) => [p.properties.style ?? 'Normal', text(p)]),
    [
      ['Heading1', 'Field Notes'],
      ['Normal', BODY + '.'],
      ['Heading2', 'Observations'],
      ['Normal', 'Notes may be bold or italic.'],
      ['ListParagraph', 'First finding here'],
      ['ListParagraph', 'Second finding here'],
      ['ListParagraph', 'Collect the samples'],
      ['ListParagraph', 'Label every jar'],
      ['ListParagraph', 'Write it all down'],
      ['Normal', 'Set in sans-serif.'],
    ],
  );

  // Runs: sizes in half-points, bold and italic from the fonts, families mapped into our set.
  const rs = runs(ps[3]);
  assert.deepEqual(
    rs.map((r) => [r.properties.bold ?? false, r.properties.italic ?? false, r.properties.size, r.properties.fonts?.ascii]),
    [
      [false, false, 22, 'Times New Roman'],
      [true, false, 22, 'Times New Roman'],
      [false, false, 22, 'Times New Roman'],
      [false, true, 22, 'Times New Roman'],
      [false, false, 22, 'Times New Roman'],
    ],
  );
  assert.equal(runs(ps[9])[0].properties.fonts?.ascii, 'Arial');
  // Headings take size and color from their style, not from the runs.
  assert.equal(runs(ps[0])[0].properties.size, undefined);
  assert.ok(doc.styles.styles.some((s) => s.id === 'Heading2') && doc.styles.styles.some((s) => s.id === 'Heading4'));

  // Lists: one bullet list, and a numbered list that starts at 1.
  const [b1, b2, n1, , n3] = ps.slice(4, 9).map((p) => p.properties.numbering!);
  assert.equal(b1.id, b2.id);
  assert.notEqual(n1.id, b1.id);
  assert.equal(n1.id, n3.id);
  const bullet = doc.numbering.abstracts.find((a) => a.id === doc.numbering.instances.find((i) => i.id === b1.id)!.abstractId)!;
  assert.equal(bullet.levels[0].format, 'bullet');
  const numbered = doc.numbering.instances.find((i) => i.id === n1.id)!;
  assert.equal(doc.numbering.abstracts.find((a) => a.id === numbered.abstractId)!.levels[0].format, 'decimal');
  assert.deepEqual(numbered.overrides, [{ level: 0, startOverride: 1 }]);

  // Page setup: A4 (595x842 pt) with margins near where the text sat (72 pt = 1440 twips).
  assert.deepEqual([doc.section.pageSize?.w, doc.section.pageSize?.h], [11900, 16840]);
  assert.equal(doc.section.margins?.left, 1440);
});

test('the imported document saves and reopens as .docx', async () => {
  const doc = await pdfToDocument(await samplePdf());
  const back = await WordDocument.read(await doc.write());
  assert.deepEqual(paragraphs(back).map(text), paragraphs(doc).map(text));
  assert.equal(back.numbering.instances.length, doc.numbering.instances.length);
  assert.equal(back.section.pageSize?.w, 11900);
});

test('two-column pages, running heads and page numbers are handled', async () => {
  const pdf = PdfDocument.create();
  const font = pdf.standardFont('Helvetica');
  for (let p = 0; p < 3; p++) {
    const d = pdf.addPage().draw({ origin: 'top-left' });
    d.text('Journal of Small Things', 72, 40, { font, size: 9 });
    const left = wrap(BODY.repeat(3) + ` left${p}.`, font, 10, 200);
    const right = wrap(BODY.toUpperCase().repeat(2) + ` RIGHT${p}.`, font, 10, 200);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if (left[i]) d.text(left[i], 72, 100 + i * 12, { font, size: 10 });
      if (right[i]) d.text(right[i], 340, 100 + i * 12, { font, size: 10 });
    }
    d.text(String(p + 1), 300, 750, { font, size: 9 });
    d.finish();
  }
  const doc = await pdfToDocument(await pdf.save());
  const texts = paragraphs(doc).map(text);
  assert.equal(texts.length, 6);
  assert.ok(texts.every((t) => !/Journal|^\d$/.test(t)));
  assert.ok(texts[0].endsWith('left0.') && texts[1].endsWith('RIGHT0.') && texts[2].endsWith('left1.'));
});

test('page breaks are opt-in', async () => {
  const pdf = PdfDocument.create();
  const font = pdf.standardFont('Helvetica');
  for (const s of ['First page.', 'Second page.']) pdf.addPage().draw({ origin: 'top-left' }).text(s, 72, 100, { font, size: 12 }).finish();
  const bytes = await pdf.save();
  const plain = paragraphs(await pdfToDocument(bytes));
  assert.deepEqual(plain.map((p) => p.properties.pageBreakBefore), [undefined, undefined]);
  const paged = paragraphs(await pdfToDocument(bytes, { pageBreaks: true }));
  assert.deepEqual(paged.map((p) => p.properties.pageBreakBefore), [undefined, true]);
});

test('landscape pages, passwords and empty documents', async () => {
  const wide = PdfDocument.create();
  wide.addPage([792, 612]).draw({ origin: 'top-left' }).text('Wide.', 72, 100, { font: wide.standardFont('Helvetica'), size: 12 }).finish();
  const doc = await pdfToDocument(await wide.save());
  assert.deepEqual([doc.section.pageSize?.w, doc.section.pageSize?.h, doc.section.pageSize?.orient], [15840, 12240, 'landscape']);

  const bytes = new Uint8Array(readFileSync(join(import.meta.dirname, '../../pdf/test/fixtures/aes-128.pdf')));
  await assert.rejects(() => pdfToDocument(bytes), PasswordError);
  const locked = await pdfToDocument(bytes, { password: 'user' });
  assert.ok(paragraphs(locked).map(text).join(' ').includes('quick brown fox'));

  const blank = PdfDocument.create();
  blank.addPage();
  const empty = await pdfToDocument(await blank.save());
  assert.equal(empty.body.length, 1);
  assert.equal(text(empty.body[0] as Paragraph), '');
});

test('PDF fonts map to the families we ship, or stay default', () => {
  assert.equal(wordFontFor('Helvetica-Bold'), 'Arial');
  assert.equal(wordFontFor('TimesNewRomanPS-BoldMT'), 'Times New Roman');
  assert.equal(wordFontFor('CourierNewPSMT'), 'Courier New');
  assert.equal(wordFontFor('Georgia-Italic'), 'Georgia');
  assert.equal(wordFontFor('LMRoman10-Regular'), 'Times New Roman');
  assert.equal(wordFontFor('DejaVuSans'), 'Arial');
  assert.equal(wordFontFor('ZapfDingbats'), undefined);
});
