// PDF import: PDFs made with the pdf package's writer, imported into the document model.
// Run: node --experimental-transform-types --test test/pdfImport.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { WordDocument, type Paragraph, type Run } from '@golemdocs/docx';
import { PageDrawing, PdfDocument, PasswordError, type PdfFont } from '../../pdf/src/index.ts';
import { pdfToDocument, wordFontFor } from '../src/formats/pdfImport.ts';
import { drawingGroups, drawingPng, drawingSvg } from '../src/formats/pdfDrawings.ts';

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
  // Headings keep the PDF's size (and color, black here), on top of the style.
  assert.equal(runs(ps[0])[0].properties.size, 48);
  assert.equal(runs(ps[0])[0].properties.color?.val, '000000');
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

test('added text boxes and pictures float at their place on their page', async () => {
  const pdf = PdfDocument.create();
  const font = pdf.standardFont('Helvetica');
  pdf.addPage([595, 842]).draw({ origin: 'top-left' }).text('First page.', 72, 100, { font, size: 12 }).finish();
  pdf.addPage([595, 842]);
  pdf.addPage([595, 842]).draw({ origin: 'top-left' }).text('Third page.', 72, 100, { font, size: 12 }).finish();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const edits = [
    { id: 'a', page: 0, kind: 'textbox' as const, box: [100, 700, 300, 740] as [number, number, number, number], text: 'Hello\nthere', font: 'Helvetica-Bold', size: 14, color: [1, 0, 0] as [number, number, number] },
    { id: 'b', page: 1, kind: 'image' as const, box: [50, 400, 150, 500] as [number, number, number, number], data: png },
  ];
  const doc = await pdfToDocument(await pdf.save(), { edits });
  const drawings = paragraphs(doc).map((p) => runs(p).flatMap((r) => r.content.filter((c) => c.kind === 'drawing')));
  // First page's paragraph carries the text box; the text-less second page gets a paragraph for the picture.
  assert.deepEqual(drawings.map((d) => d.length), [1, 1, 0]);
  const box = drawings[0][0];
  const picture = drawings[1][0];
  assert.ok(box.kind === 'drawing' && !box.inline && box.textBox?.length === 2);
  assert.ok(picture.kind === 'drawing' && !picture.inline && picture.image);
  assert.deepEqual([box.width, box.height], [200 * 12700, 40 * 12700]);
  const paragraphsOn = paragraphs(doc);
  assert.equal(paragraphsOn[1].properties.pageBreakBefore, true);
  assert.equal(paragraphsOn[2].properties.pageBreakBefore, true);
  // The box's top-left is 100pt from the left, 842 - 740 = 102pt from the top.
  assert.match(JSON.stringify(box.xml), /1270000/);
  assert.match(JSON.stringify(box.xml), /1295400/);

  // Written and read back, the text box keeps its text.
  const back = await WordDocument.read(await doc.write());
  const again = paragraphs(back)[0].children.flatMap((c) => (c.kind === 'run' ? c.content : [])).find((c) => c.kind === 'drawing');
  assert.ok(again && again.kind === 'drawing' && again.textBox?.length === 2);
  assert.equal(text(again.textBox![0] as Paragraph), 'Hello');
});

test('lines centered on a point that is not the column middle become a centered, right-indented heading', async () => {
  const pdf = PdfDocument.create();
  const font = pdf.standardFont('Helvetica');
  const d = pdf.addPage([595, 842]).draw({ origin: 'top-left' });
  // Two big lines centered on x = 190, with body text across the full width under them.
  for (const [s, y] of [['Name', 100], ['Second line', 136]] as [string, number][]) {
    d.text(s, 190 - PageDrawing.measure(s, { font, size: 30 }) / 2, y, { font, size: 30 });
  }
  d.text('Body text runs across the whole page width here, well past the title.', 57, 220, { font, size: 11 });
  d.text('Second body line that also spans a good part of the page as well.', 57, 234, { font, size: 11 });
  d.finish();
  const ps = paragraphs(await pdfToDocument(await pdf.save()));
  assert.equal(ps[0].properties.style, 'Heading1');
  assert.equal(ps[0].properties.justification, 'center');
  assert.ok((ps[0].properties.indent?.right ?? 0) > 800);
  // The title keeps its two lines.
  assert.deepEqual(runs(ps[0]).flatMap((r) => r.content.map((c) => (c.kind === 'text' ? c.text : c.kind))), ['Name', 'break', 'Second line']);
});
test("blocks keep the PDF's line pitch and the gaps between them", async () => {
  const pdf = PdfDocument.create();
  const font = pdf.standardFont('Helvetica');
  const d = pdf.addPage([595, 842]).draw({ origin: 'top-left' });
  const o = { font, size: 9 };
  // Lines 14pt apart; a 28pt gap (one blank line) before the last.
  d.text('First line of the note.', 57, 100, o);
  d.text('Second line of the note.', 57, 114, o);
  d.text('After a gap of one line.', 57, 156, o);
  d.finish();
  const ps = paragraphs(await pdfToDocument(await pdf.save()));
  const spacing = ps.map((p) => p.properties.spacing);
  assert.ok(spacing.every((s) => s?.lineRule === 'exact' && s.line === 280 && s.after === 0));
  assert.equal(spacing[spacing.length - 1]?.before, 560);
});

test('year-led entries stay separate, and an address set in from the edge keeps its lines', async () => {
  const pdf = PdfDocument.create();
  const font = pdf.standardFont('Helvetica');
  const d = pdf.addPage([595, 842]).draw({ origin: 'top-left' });
  const o = { font, size: 9 };
  // The first entry runs to the column's edge; the next starts with a year.
  d.text('2024 A long entry that runs nearly all the way across the page to the right edge of the column ok', 57, 100, o);
  d.text('2023 Short entry', 57, 114, o);
  d.text('Some closing prose that also spans a good part of the width here, to set the column wide enough.', 57, 300, o);
  d.text('Address line one here', 300, 700, o);
  d.text('Phone 000', 300, 710, o);
  d.finish();
  const ps = paragraphs(await pdfToDocument(await pdf.save()));
  assert.deepEqual(ps.map(text).slice(0, 2).map((t) => t.slice(0, 4)), ['2024', '2023']);
  const address = ps[ps.length - 1];
  assert.deepEqual(runs(address).flatMap((r) => r.content.map((c) => c.kind)), ['text', 'break', 'text']);
});

const drawingsOf = (doc: WordDocument) => paragraphs(doc).flatMap((p) => runs(p).flatMap((r) => r.content.filter((c) => c.kind === 'drawing')));

/** Pixels (RGBA) of a PNG the pdf package writes: 8-bit, unfiltered rows. */
function pixelsOf(png: Uint8Array): { width: number; height: number; at(x: number, y: number): number[] } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const channels = ({ 0: 1, 2: 3, 6: 4 } as Record<number, number>)[png[25]];
  const data: number[] = [];
  for (let p = 8; p < png.length; ) {
    const length = view.getUint32(p);
    if (String.fromCharCode(...png.subarray(p + 4, p + 8)) === 'IDAT') data.push(...png.subarray(p + 8, p + 8 + length));
    p += 12 + length;
  }
  const raw = inflateSync(Uint8Array.from(data));
  return {
    width,
    height,
    at: (x, y) => {
      const o = y * (width * channels + 1) + 1 + x * channels;
      const px = Array.from(raw.subarray(o, o + channels));
      return channels === 4 ? px : channels === 3 ? [...px, 255] : [px[0], px[0], px[0], 255];
    },
  };
}

test('a drawing made of many small squares (a QR code) becomes one picture', async () => {
  const pdf = PdfDocument.create();
  const font = pdf.standardFont('Helvetica');
  const page = pdf.addPage([595, 842]).draw({ origin: 'top-left' });
  page.text('Scan me.', 72, 60, { font, size: 12 });
  for (let row = 0; row < 12; row++) for (let col = 0; col < 12; col++) if ((row + col) % 2 === 0) page.rect(100 + col * 6, 200 + row * 6, 6, 6, { fill: [0, 0, 0] });
  page.finish();
  const found = drawingsOf(await pdfToDocument(await pdf.save()));
  assert.equal(found.length, 1);
  const picture = found[0];
  assert.ok(picture.kind === 'drawing' && !picture.inline && picture.image && picture.svg);
  assert.deepEqual([picture.width, picture.height], [72 * 12700, 72 * 12700]);
});

test('curved vector art becomes a picture with an SVG; rules, boxes and bullets stay out', async () => {
  const pdf = PdfDocument.create();
  const page = pdf.addPage([595, 842]).draw({ origin: 'top-left' });
  page.ellipse(200, 300, 60, 40, { fill: [1, 0, 0], stroke: { color: [0, 0, 1], width: 3 } });
  page.line(50, 100, 545, 100, { color: [0, 0, 0], width: 1 });
  page.rect(50, 500, 495, 80, { stroke: { color: [0, 0, 0], width: 1 } });
  page.rect(60, 650, 200, 20, { fill: [0.9, 0.9, 0.9] });
  page.ellipse(70, 700, 2, 2, { fill: [0, 0, 0] });
  page.finish();
  const found = drawingsOf(await pdfToDocument(await pdf.save()));
  assert.equal(found.length, 1);
  const picture = found[0];
  assert.ok(picture.kind === 'drawing' && picture.image && picture.svg);
  // The ellipse and its 3pt outline: 120 + 3 wide, 80 + 3 tall.
  assert.ok(Math.abs(picture.width / 12700 - 123) < 1 && Math.abs(picture.height / 12700 - 83) < 1);
});

test('a drawing is written as SVG paths and drawn into a PNG from the same shapes', async () => {
  const pdf = PdfDocument.create();
  const page = pdf.addPage([200, 200]).draw({ origin: 'top-left' });
  page.ellipse(100, 100, 50, 50, { fill: [1, 0, 0] });
  page.finish();
  const doc = await PdfDocument.load(await pdf.save());
  const { interpretPage } = await import('../../pdf/src/index.ts');
  const display = interpretPage(doc.pages[0], { paths: true });
  const [group] = drawingGroups(display.paths, display);
  assert.ok(group);
  assert.deepEqual(group.frame, { x: 50, y: 50, width: 100, height: 100 });
  assert.match(drawingSvg(group), /^<svg [^>]*viewBox="0 0 100 100"><path d="M[^"]+Z" fill="#ff0000"\/><\/svg>$/);
  const png = pixelsOf(drawingPng(group));
  assert.deepEqual(png.at(Math.floor(png.width / 2), Math.floor(png.height / 2)), [255, 0, 0, 255]);
  assert.equal(png.at(1, 1)[3], 0);
});
