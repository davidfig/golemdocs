import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PageDrawing, PdfDocument, analyzeDocument, reflowDocument, reflowPage, type PdfFont, type ReflowBlock } from '../src/index.ts';
import { load } from './helpers.ts';

// --- Helpers: draw pages with the package's writer, save, reload, reflow ------------------------

interface Fonts {
  regular: PdfFont;
  bold: PdfFont;
  italic: PdfFont;
}

const fontsOf = (doc: PdfDocument): Fonts => ({
  regular: doc.standardFont('Helvetica'),
  bold: doc.standardFont('Helvetica-Bold'),
  italic: doc.standardFont('Helvetica-Oblique'),
});

const reload = async (doc: PdfDocument) => PdfDocument.load(await doc.save());

/** Greedy line breaking. */
function wrap(text: string, font: PdfFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && PageDrawing.measure(next, { font, size }) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Draws lines, justified to `width` (the last one ragged); returns the baseline after the last. */
function drawLines(d: PageDrawing, lines: string[], x: number, y: number, o: { font: PdfFont; size: number; width: number; leading?: number }): number {
  const leading = o.leading ?? o.size * 1.25;
  lines.forEach((line, i) => {
    const natural = PageDrawing.measure(line, o);
    const spaces = line.split(' ').length - 1;
    const wordSpacing = i < lines.length - 1 && spaces ? (o.width - natural) / spaces : 0;
    d.text(line, x, y + i * leading, { font: o.font, size: o.size, wordSpacing });
  });
  return y + lines.length * leading;
}

const words = (n: number, seed = 0) => {
  const base = ['quiet', 'river', 'stone', 'lantern', 'meadow', 'copper', 'harbor', 'violet', 'window', 'ember', 'garden', 'marble'];
  return Array.from({ length: n }, (_, i) => base[(i * 7 + seed) % base.length]).join(' ');
};
const sentence = (n: number, seed = 0) => {
  const w = words(n, seed);
  return w[0].toUpperCase() + w.slice(1) + '.';
};

const text = (b: ReflowBlock) => (b.kind === 'pageBreak' ? '' : b.runs.map((r) => r.text).join(''));
const kinds = (blocks: ReflowBlock[]) => blocks.map((b) => b.kind);

// --- Tests -------------------------------------------------------------------------------------

test('lines merge into paragraphs by spacing; a paragraph gap starts a new one', async () => {
  const doc = PdfDocument.create();
  const f = fontsOf(doc);
  const d = doc.addPage().draw({ origin: 'top-left' });
  const p1 = sentence(45);
  const p2 = sentence(30, 3);
  const o = { font: f.regular, size: 11, width: 400 };
  let y = drawLines(d, wrap(p1, f.regular, 11, 400), 72, 100, o);
  y = drawLines(d, wrap(p2, f.regular, 11, 400), 72, y + 10, o);
  d.finish();
  const blocks = reflowDocument(await reload(doc));
  assert.deepEqual(kinds(blocks), ['paragraph', 'paragraph']);
  assert.equal(text(blocks[0]), p1);
  assert.equal(text(blocks[1]), p2);
});

test('a first-line indent starts a paragraph and is reported', async () => {
  const doc = PdfDocument.create();
  const f = fontsOf(doc);
  const d = doc.addPage().draw({ origin: 'top-left' });
  const o = { font: f.regular, size: 11, width: 400 };
  const p1 = words(60);
  const p2 = words(40, 5);
  const l1 = wrap(p1, f.regular, 11, 400);
  let y = drawLines(d, l1, 72, 100, { ...o, width: 400 });
  // Indented first line, the rest flush: wrap the first line narrower.
  const first = wrap(p2, f.regular, 11, 382);
  const firstLine = first[0];
  const rest = wrap(p2.slice(firstLine.length + 1), f.regular, 11, 400);
  d.text(firstLine, 90, y, { font: f.regular, size: 11, wordSpacing: (382 - PageDrawing.measure(firstLine, o)) / (firstLine.split(' ').length - 1) });
  y = drawLines(d, rest, 72, y + 13.75, o);
  d.finish();
  const blocks = reflowDocument(await reload(doc));
  assert.deepEqual(kinds(blocks), ['paragraph', 'paragraph']);
  assert.equal(text(blocks[0]), p1);
  assert.equal(text(blocks[1]), p2);
  const b = blocks[1];
  assert.ok(b.kind === 'paragraph' && b.indent && Math.abs(b.indent.firstLine - 18) < 1 && b.indent.left === 0, JSON.stringify(b));
});

test('line-end hyphens are removed inside words and kept in compounds', async () => {
  const doc = PdfDocument.create();
  const f = fontsOf(doc);
  const d = doc.addPage().draw({ origin: 'top-left' });
  const lines = ['The research team described a new infor-', 'mation system invented by Jean-', 'Paul Martin, who built it in the small', 'lab over many quiet years.'];
  drawLines(d, lines, 72, 100, { font: f.regular, size: 11, width: 300 });
  d.finish();
  const blocks = reflowDocument(await reload(doc));
  assert.equal(blocks.length, 1);
  assert.equal(text(blocks[0]), 'The research team described a new information system invented by Jean-Paul Martin, who built it in the small lab over many quiet years.');
});

test('headings: larger and bold-at-body-size lines, ranked into levels; centered text is aligned', async () => {
  const doc = PdfDocument.create();
  const f = fontsOf(doc);
  const d = doc.addPage().draw({ origin: 'top-left' });
  const o = { font: f.regular, size: 11, width: 400 };
  const title = 'Annual Report';
  const tw = PageDrawing.measure(title, { font: f.bold, size: 22 });
  d.text(title, 72 + (400 - tw) / 2, 100, { font: f.bold, size: 22 });
  let y = drawLines(d, wrap(sentence(50), f.regular, 11, 400), 72, 140, o);
  d.text('Background', 72, y + 20, { font: f.bold, size: 15 });
  y = drawLines(d, wrap(sentence(50, 2), f.regular, 11, 400), 72, y + 40, o);
  d.text('Definitions', 72, y + 16, { font: f.bold, size: 11 });
  drawLines(d, wrap(sentence(50, 4), f.regular, 11, 400), 72, y + 34, o);
  d.finish();
  const blocks = reflowDocument(await reload(doc));
  assert.deepEqual(kinds(blocks), ['heading', 'paragraph', 'heading', 'paragraph', 'heading', 'paragraph']);
  const levels = blocks.filter((b) => b.kind === 'heading').map((b) => (b as { level: number }).level);
  assert.deepEqual(levels, [1, 2, 3]);
  assert.equal(text(blocks[0]), 'Annual Report');
  assert.equal((blocks[0] as { align?: string }).align, 'center');
  assert.equal(text(blocks[2]), 'Background');
  assert.equal(text(blocks[4]), 'Definitions');
});

test('bullets, numbers and lettered lists become list items; wrapped text stays in its item', async () => {
  const doc = PdfDocument.create();
  const f = fontsOf(doc);
  const d = doc.addPage().draw({ origin: 'top-left' });
  const o = { font: f.regular, size: 11, width: 400 };
  let y = drawLines(d, wrap(sentence(50), f.regular, 11, 400), 72, 100, o);
  y += 8;
  const item = (marker: string, body: string, markerX: number, textX = markerX + 18) => {
    d.text(marker, markerX, y, { font: f.regular, size: 11 });
    y = drawLines(d, wrap(body, f.regular, 11, 472 - textX), textX, y, { ...o, width: 472 - textX });
  };
  const wrapped = sentence(18, 1);
  item('•', wrapped, 72);
  item('•', sentence(4, 2), 72);
  item('•', sentence(3, 3), 90);
  y += 8;
  item('1.', sentence(4), 72);
  item('2.', sentence(5, 1), 72);
  y += 8;
  item('a)', sentence(4, 2), 72);
  item('b)', sentence(4, 4), 72);
  y += 8;
  d.text('A. Not a list, just a sentence that starts with a letter.', 72, y, { font: f.regular, size: 11 });
  d.finish();
  const blocks = reflowDocument(await reload(doc));
  const items = blocks.filter((b) => b.kind === 'listItem') as Extract<ReflowBlock, { kind: 'listItem' }>[];
  assert.deepEqual(
    items.map((b) => [b.ordered, b.marker, b.level, text(b)]),
    [
      [false, '•', 0, wrapped],
      [false, '•', 0, sentence(4, 2)],
      [false, '•', 1, sentence(3, 3)],
      [true, '1.', 0, sentence(4)],
      [true, '2.', 0, sentence(5, 1)],
      [true, 'a)', 0, sentence(4, 2)],
      [true, 'b)', 0, sentence(4, 4)],
    ],
  );
  assert.deepEqual([items[3].format, items[3].start, items[5].format, items[5].start], ['decimal', 1, 'lowerLetter', 1]);
  // Marker and text positions carry over: text 18pt in from the marker, markers 0 / 18pt in from the column.
  const near = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1.5, `${a} vs ${b}`);
  const col = items[0].indent!.left - 18;
  near(items[0].indent!.left - col, 18);
  near(items[0].indent!.firstLine, -18);
  near(items[2].indent!.left - col, 36);
  near(items[2].indent!.firstLine, -18);
  assert.equal(blocks[0].kind, 'paragraph');
  const last = blocks[blocks.length - 1];
  assert.equal(last.kind, 'paragraph');
  assert.match(text(last), /^A\. Not a list/);
});

test('two columns are read column by column, under a full-width title', async () => {
  const doc = PdfDocument.create();
  const f = fontsOf(doc);
  const d = doc.addPage().draw({ origin: 'top-left' });
  const tw = PageDrawing.measure('Two Column Study', { font: f.bold, size: 18 });
  d.text('Two Column Study', (612 - tw) / 2, 90, { font: f.bold, size: 18 });
  const o = { font: f.regular, size: 10, width: 200, leading: 12.5 };
  const left1 = sentence(40);
  const left2 = sentence(30, 2);
  const right1 = sentence(45, 5);
  // Rows are drawn left/right alternately at the same baselines, as a real two-column page is.
  const l1 = wrap(left1, f.regular, 10, 200);
  const l2 = wrap(left2, f.regular, 10, 200);
  const r1 = wrap(right1, f.regular, 10, 200);
  const y0 = 130;
  drawLines(d, r1, 340, y0, o);
  const endLeft = drawLines(d, l1, 72, y0, o);
  drawLines(d, l2, 72, endLeft + 8, o);
  d.finish();
  const blocks = reflowDocument(await reload(doc));
  assert.deepEqual(blocks.map((b) => text(b)), ['Two Column Study', left1, left2, right1]);
  assert.equal(blocks[0].kind, 'heading');
});

test('a paragraph continues from the bottom of one column to the top of the next', async () => {
  const doc = PdfDocument.create();
  const f = fontsOf(doc);
  const d = doc.addPage().draw({ origin: 'top-left' });
  const body = words(120) + ' end.';
  const lines = wrap(body, f.regular, 10, 200);
  const half = Math.ceil(lines.length / 2);
  const o = { font: f.regular, size: 10, width: 200, leading: 12.5 };
  // Justified left column (all lines full), then the right column.
  const leftLines = lines.slice(0, half);
  leftLines.forEach((line, i) => {
    const spaces = line.split(' ').length - 1;
    d.text(line, 72, 100 + i * 12.5, { font: f.regular, size: 10, wordSpacing: (200 - PageDrawing.measure(line, o)) / spaces });
  });
  drawLines(d, lines.slice(half), 340, 100, o);
  d.finish();
  const blocks = reflowDocument(await reload(doc));
  assert.equal(blocks.length, 1);
  assert.equal(text(blocks[0]), body);
});

test('running headers, footers and page numbers are dropped; a paragraph carries across pages', async () => {
  const doc = PdfDocument.create();
  const f = fontsOf(doc);
  const body = words(240);
  const lines = wrap(body, f.regular, 11, 400);
  const per = Math.ceil(lines.length / 4);
  const o = { font: f.regular, size: 11, width: 400 };
  for (let p = 0; p < 4; p++) {
    const d = doc.addPage().draw({ origin: 'top-left' });
    d.text('Quarterly Review', 72, 40, { font: f.italic, size: 9 });
    drawLines(d, lines.slice(p * per, (p + 1) * per), 72, 100, { ...o, width: 400 });
    const label = `Page ${p + 1} of 4`;
    d.text(label, 306 - PageDrawing.measure(label, { font: f.regular, size: 9 }) / 2, 760, { font: f.regular, size: 9 });
    d.finish();
  }
  const back = await reload(doc);
  const blocks = reflowDocument(back);
  assert.equal(blocks.length, 1, kinds(blocks).join());
  assert.equal(text(blocks[0]), body);
  // Explicit page breaks instead of joining.
  const paged = reflowDocument(back, { pageBreaks: true });
  assert.deepEqual(kinds(paged), ['paragraph', 'pageBreak', 'paragraph', 'pageBreak', 'paragraph', 'pageBreak', 'paragraph']);
  assert.deepEqual(analyzeDocument(back).pages.length, 4);
});

test('a lone page number is dropped even from a single page', async () => {
  const doc = PdfDocument.create();
  const f = fontsOf(doc);
  const d = doc.addPage().draw({ origin: 'top-left' });
  d.text('A short page of text.', 72, 100, { font: f.regular, size: 11 });
  d.text('7', 300, 750, { font: f.regular, size: 10 });
  d.finish();
  const page = reflowPage((await reload(doc)).pages[0]);
  assert.deepEqual(page.blocks.map(text), ['A short page of text.']);
  assert.equal(page.bodySize, 11);
  assert.deepEqual([page.width, page.height], [612, 792]);
  assert.ok(Math.abs(page.margins.left - 72) < 1);
});

test('bold and italic come from the font; runs keep size and font name', async () => {
  const doc = PdfDocument.create();
  const f = fontsOf(doc);
  const d = doc.addPage().draw({ origin: 'top-left' });
  let x = 72;
  for (const [s, font] of [['This is ', f.regular], ['bold', f.bold], [' and ', f.regular], ['slanted', f.italic], [' text.', f.regular]] as [string, PdfFont][]) {
    d.text(s, x, 100, { font, size: 12 });
    x += PageDrawing.measure(s, { font, size: 12 });
  }
  d.finish();
  const [b] = reflowDocument(await reload(doc));
  assert.ok(b.kind === 'paragraph');
  assert.deepEqual(
    b.runs.map((r) => [r.text, r.bold, r.italic, r.size, r.fontName]),
    [
      ['This is ', false, false, 12, 'Helvetica'],
      ['bold', true, false, 12, 'Helvetica-Bold'],
      [' and ', false, false, 12, 'Helvetica'],
      ['slanted', false, true, 12, 'Helvetica-Oblique'],
      [' text.', false, false, 12, 'Helvetica'],
    ],
  );
});

test('invisible (OCR) text is kept; rotated text and rotated pages are skipped', async () => {
  const doc = PdfDocument.create();
  const f = fontsOf(doc);
  const d = doc.addPage().draw({ origin: 'top-left' });
  d.text('Scanned words from an OCR layer.', 72, 100, { font: f.regular, size: 11, render: 'invisible' });
  d.finish();
  const rotated = doc.addPage();
  rotated.draw({ origin: 'top-left' }).text('Sideways on a rotated page.', 72, 100, { font: f.regular, size: 11 }).finish();
  rotated.rotation = 90;
  const blocks = reflowDocument(await reload(doc));
  assert.deepEqual(blocks.map(text), ['Scanned words from an OCR layer.']);
});

test('real-world producer fixtures', () => {
  const chromium = reflowDocument(load('chromium.pdf'));
  assert.deepEqual(chromium.map(text), ['The quick brown fox jumps over the lazy dog.', 'Café naïve résumé – “quoted” fi fl 1234']);
  const latex = reflowDocument(load('xelatex.pdf'));
  assert.deepEqual(latex.map(text), ['The quick brown fox jumps over the lazy dog. Café naïve résumé – “quoted” fi fl 1234']);
  const report = reflowDocument(load('reportlab.pdf'));
  assert.equal(report.length, 2);
  assert.equal(text(report[1]), 'Second page');
});

test('a few hundred pages reflow quickly', async () => {
  const doc = PdfDocument.create();
  const f = fontsOf(doc);
  for (let p = 0; p < 300; p++) {
    const d = doc.addPage().draw({ origin: 'top-left' });
    d.text(`Chapter ${p}`, 72, 60, { font: f.bold, size: 9 });
    drawLines(d, wrap(sentence(150, p), f.regular, 11, 400), 72, 100, { font: f.regular, size: 11, width: 400 });
    d.finish();
  }
  const back = await reload(doc);
  const started = performance.now();
  const blocks = reflowDocument(back);
  const took = performance.now() - started;
  assert.equal(blocks.length, 300);
  assert.ok(took < 15000, `${took}ms`);
});

test('two of the same narrow letter in a row are not faux bold, text colors are kept, and running heads and feet are kept apart from the body', async () => {
  const doc = PdfDocument.create();
  const f = fontsOf(doc);
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([612, 792]).draw({ origin: 'top-left' });
    page.text('Running title', 200, 30, { font: f.regular, size: 8 });
    // "All" drawn a letter at a time, as a PDF made by a browser does.
    page.fillColor([1, 0, 0]);
    let x = 100;
    for (const ch of ['A', 'l', 'l']) {
      page.text(ch, x, 300, { font: f.italic, size: 11 });
      x += PageDrawing.measure(ch, { font: f.italic, size: 11 });
    }
    page.fillColor([0, 0, 0]).text(`Page ${i + 1} of 3`, 280, 770, { font: f.regular, size: 8 });
  }
  const result = analyzeDocument(await reload(doc), { pageBreaks: true });
  const text = result.blocks.flatMap((b) => (b.kind === 'pageBreak' ? [] : b.runs));
  assert.equal(text.length, 3);
  for (const run of text) {
    assert.equal(run.text, 'All');
    assert.equal(run.bold, false);
    assert.equal(run.color, 'FF0000');
  }
  // The head and foot are not body text, but they are not lost either.
  assert.deepEqual(result.running?.header.map((l) => l.segments.map((s) => s.runs.map((r) => r.text).join(''))), [['Running title']]);
  const [foot] = result.running!.footer;
  assert.equal(foot.segments[0].pageNumber, true);
  assert.equal(foot.segments[0].runs.map((r) => r.text).join(''), 'Page 1 of 3');
});
