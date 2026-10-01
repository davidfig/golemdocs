import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { mathInline, parseLatex, WordDocument, type Paragraph } from '@golemdocs/docx';
import { FontSet, layoutDocument, toModel, type PageLayout } from '../src/index.ts';

// Uses the generated fonts in client/public/fonts (run `pnpm fonts` first).
const FONT_DIR = path.resolve(import.meta.dirname, '../../client/public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'libertinus-math', 'math.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const load = () => FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8')));

const run = (text: string) => ({ kind: 'run' as const, properties: {}, content: [{ kind: 'text' as const, text }], attrs: {} });
const paragraph = (children: Paragraph['children'], properties: Paragraph['properties'] = {}): Paragraph => ({ kind: 'paragraph', properties, children, attrs: {} });
const equation = (latex: string, display = false) => mathInline(parseLatex(latex, display).equation);

async function layout(body: Paragraph[], fonts: FontSet) {
  const doc = await WordDocument.create();
  doc.body = body;
  return layoutDocument(doc, fonts);
}

const mathKeys = (page: PageLayout) => [...page.glyphs.keys()].filter((k) => k.startsWith('libertinus-math'));

test('an equation sits inline: its glyphs come from the math font, on the same line as the text', skip, async () => {
  const fonts = await load();
  const doc = await layout([paragraph([run('See '), equation('x^2 + y^2 = z^2'), run(' here')])], fonts);
  const page = doc.pages[0];
  assert.equal(page.lines.length, 1);
  assert.equal(mathKeys(page).length, 1);
  const list = page.glyphs.get(mathKeys(page)[0])!;
  // x y z (italic), the three 2s as scripts, + and =: 8 glyphs.
  assert.equal(list.count, 8);
  const sizes = Array.from({ length: list.count }, (_, i) => list.size(i));
  assert.equal(sizes.filter((s) => s < 11).length, 3, 'the exponents are smaller than the 11 pt text');
  // Superscripts are raised above the baseline of the letters.
  const ys = Array.from({ length: list.count }, (_, i) => list.y(i));
  assert.ok(Math.min(...ys) < Math.max(...ys) - 3);
  // Text on both sides is still there.
  assert.equal(page.glyphs.get([...page.glyphs.keys()].find((k) => !k.startsWith('libertinus'))!)!.count, 'Seehere'.length);
});

test('the equation is one caret position, as wide as it is drawn', skip, async () => {
  const fonts = await load();
  const doc = await layout([paragraph([run('See '), equation('\\frac{a}{b}'), run(' here')])], fonts);
  const line = doc.pages[0].lines[0];
  assert.equal(line.end - line.start, 4 + 1 + 5);
  // Model offsets: 'See ' is 0-3, the equation position 4, ' here' 5-9.
  assert.equal(toModel(line.spans, 4), 4);
  assert.equal(toModel(line.spans, 5), 5);
  const before = line.stops[4];
  const after = line.stops[5];
  assert.ok(after - before > 3 && after - before < 30, `width ${after - before}`);
});

test('a tall equation makes its line taller; the baseline stays with the text', skip, async () => {
  const fonts = await load();
  const plain = await layout([paragraph([run('See here')])], fonts);
  const tall = await layout([paragraph([run('See '), equation('\\frac{\\frac{a}{b}}{\\frac{c}{d}}'), run(' here')])], fonts);
  const p = plain.pages[0].lines[0];
  const t = tall.pages[0].lines[0];
  assert.ok(t.height > p.height + 8, `${t.height} vs ${p.height}`);
  assert.ok(t.baseline > p.baseline + 3);
});

test('a display equation alone in its paragraph is centered', skip, async () => {
  const fonts = await load();
  const doc = await layout([paragraph([equation('\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}', true)])], fonts);
  const section = doc.sections[0];
  const line = doc.pages[0].lines[0];
  const leftGap = line.x - section.left;
  const rightGap = section.left + section.contentWidth - (line.x + line.width);
  assert.ok(leftGap > 50, `centered, not at the margin (${leftGap})`);
  assert.ok(Math.abs(leftGap - rightGap) < 1, `${leftGap} vs ${rightGap}`);
  // Display style draws the sum larger than inline.
  const inline = await layout([paragraph([equation('\\sum_{i=1}^{n} i')])], fonts);
  const display = await layout([paragraph([equation('\\sum_{i=1}^{n} i', true)])], fonts);
  assert.ok(display.pages[0].lines[0].height > inline.pages[0].lines[0].height);
});

test('an equation never breaks across lines', skip, async () => {
  const fonts = await load();
  const words = Array.from({ length: 30 }, () => 'word').join(' ');
  const doc = await layout([paragraph([run(words + ' '), equation('a + b + c = d + e + f'), run(' end')])], fonts);
  const page = doc.pages[0];
  // The math font's glyphs of one equation all sit on a single line.
  const list = page.glyphs.get(mathKeys(page)[0])!;
  const lineOf = (y: number) => page.lines.findIndex((l) => y >= l.y && y <= l.y + l.height + 1);
  const rows = new Set(Array.from({ length: list.count }, (_, i) => lineOf(list.y(i))));
  assert.equal(rows.size, 1);
  assert.ok(page.lines.length > 1);
});

test('the math font loads only for documents with equations, and equations edited in are laid out once it has', skip, async () => {
  const fonts = await load();
  await layout([paragraph([run('no math here')])], fonts);
  assert.equal(fonts.mathData, undefined, 'a plain document does not fetch the math font');
  const doc = await layout([paragraph([equation('x')])], fonts);
  assert.ok(fonts.mathData);
  assert.equal(mathKeys(doc.pages[0]).length, 1);
  // Text before the font is loaded: nothing drawn, no room taken (a document opens, then the font arrives).
  const early = await load();
  const d = await WordDocument.create();
  d.body = [paragraph([run('a'), equation('x'), run('b')])];
  const session = await import('../src/index.ts').then((m) => m.LayoutSession.create(d, early));
  await session.run();
  assert.equal(mathKeys(session.pages[0]).length, 1, 'opening a document with an equation loads the font first');
});

test('the formatting marks of a line that starts with an equation use the text face', skip, async () => {
  const fonts = await load();
  const { setFormattingMarks } = await import('../src/index.ts');
  setFormattingMarks(true);
  try {
    const doc = await layout([paragraph([equation('x'), run(' text')])], fonts);
    const page = doc.pages[0];
    for (const key of mathKeys(page)) {
      // Only the equation's own glyph is in the math face: no pilcrow or space dots.
      assert.equal(page.glyphs.get(key)!.count, 1);
    }
  } finally {
    setFormattingMarks(false);
  }
});
