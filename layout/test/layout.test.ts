import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WordDocument, type Paragraph, type Run, type Table } from '@golemdocs/docx';
import { encodePage, FontSet, GLYPH_INSTANCE_BYTES, layoutDocument, setFormattingMarks, setReflowWidth, type PageLayout } from '../src/index.ts';

// Uses the generated font metrics in client/public/fonts (run `pnpm fonts` first).
const FONT_DIR = path.resolve(import.meta.dirname, '../../client/public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

const run = (text: string, properties: Run['properties'] = {}): Run => ({
  kind: 'run',
  properties,
  content: [{ kind: 'text', text }],
  attrs: {},
});
const paragraph = (children: Paragraph['children'], properties: Paragraph['properties'] = {}): Paragraph => ({
  kind: 'paragraph',
  properties,
  children,
  attrs: {},
});
const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore ' +
  'magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo.';

test('paragraphs wrap inside the margins and paginate', skip, async () => {
  const doc = await WordDocument.create();
  doc.body = Array.from({ length: 80 }, () => paragraph([run(LOREM)]));
  const layout = await layoutDocument(doc, fonts!);
  assert.ok(layout.pages.length >= 4, `${layout.pages.length} pages`);
  const s = layout.sections[0];
  assert.equal(s.width, 612);
  for (const page of layout.pages) {
    for (const line of page.lines) {
      assert.ok(line.x >= s.left - 0.01 && line.x + line.width <= s.left + s.contentWidth + 0.01, 'line inside margins');
      assert.ok(line.y >= s.top - 0.01 && line.y + line.height <= s.height - s.bottom + 0.01, 'line inside margins');
    }
  }
  // Every non-space character becomes a glyph.
  const glyphs = layout.pages.reduce((n, p) => n + p.glyphCount, 0);
  assert.equal(glyphs, 80 * LOREM.replace(/ /g, '').length);
});

test('page number fields in footers', skip, async () => {
  const doc = await WordDocument.create();
  const footer = doc.addHeaderFooter('footer');
  footer.children = [
    paragraph([
      run('Page '),
      { kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'fieldChar', type: 'begin', xml: { name: 'w:fldChar', attrs: {}, children: [] } }] },
      { kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'instrText', text: ' PAGE ' }] },
      { kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'fieldChar', type: 'separate', xml: { name: 'w:fldChar', attrs: {}, children: [] } }] },
      run('1'),
      { kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'fieldChar', type: 'end', xml: { name: 'w:fldChar', attrs: {}, children: [] } }] },
    ]),
  ];
  doc.section.footers.push({ type: 'default', part: footer.part });
  doc.body = Array.from({ length: 3 }, (_, i) =>
    paragraph([run(`Page ${i + 1} body`)], i > 0 ? { pageBreakBefore: true } : {}),
  );
  const layout = await layoutDocument(doc, fonts!);
  assert.equal(layout.pages.length, 3);
  // The footer on page 3 shows "Page 3": its line covers 6 characters ("Page 3" minus the space).
  const footerLines = layout.pages[2].lines.filter((l) => l.paragraph === footer.children[0]);
  assert.equal(footerLines.length, 1);
  const glyphsOnPage3 = layout.pages[2].glyphCount;
  assert.equal(glyphsOnPage3, 'Page3body'.length + 'Page3'.length);
});

test('a tall table row splits across pages', skip, async () => {
  const doc = await WordDocument.create();
  const table: Table = {
    kind: 'table',
    properties: { style: 'TableGrid' },
    grid: [9360],
    rows: [
      {
        kind: 'row',
        properties: {},
        attrs: {},
        cells: [
          {
            kind: 'cell',
            properties: {},
            attrs: {},
            children: Array.from({ length: 120 }, (_, i) => paragraph([run(`Line ${i}`)])),
          },
        ],
      },
    ],
  };
  doc.body = [table, paragraph([run('After')])];
  const layout = await layoutDocument(doc, fonts!);
  assert.ok(layout.pages.length >= 3, `${layout.pages.length} pages`);
  const lines = layout.pages.flatMap((p) => p.lines);
  assert.equal(lines.length, 121, 'every line placed exactly once');
  for (const page of layout.pages) {
    for (const line of page.lines) assert.ok(line.y + line.height <= page.height - 72 + 0.01, 'row parts stay above the bottom margin');
  }
});

test('keep with next moves a heading to the next page', skip, async () => {
  const doc = await WordDocument.create();
  const filler = Array.from({ length: 40 }, () => paragraph([run('Filler')]));
  const heading = paragraph([run('Heading')], { style: 'Heading1' });
  doc.body = [...filler, heading, paragraph([run(LOREM)])];
  const layout = await layoutDocument(doc, fonts!);
  const headingPage = layout.pages.findIndex((p) => p.lines.some((l) => l.paragraph === heading));
  const bodyPage = layout.pages.findIndex((p) => p.lines.some((l) => l.paragraph === doc.body.at(-1)));
  assert.equal(headingPage, bodyPage, 'heading stays with the next paragraph');
});

test('streaming delivers every page in order, then header/footer overlays', skip, async () => {
  const doc = await WordDocument.create();
  const footer = doc.addHeaderFooter('footer');
  footer.children = [paragraph([run('Footer text')])];
  doc.section.footers.push({ type: 'default', part: footer.part });
  doc.body = Array.from({ length: 200 }, () => paragraph([run(LOREM)]));

  const whole = await layoutDocument(doc, fonts!);
  const streamed: number[] = [];
  const overlays: number[] = [];
  let slices = 0;
  const result = await layoutDocument(doc, fonts!, {
    onPage: (page) => {
      assert.equal(overlays.length, 0, 'bodies come before overlays');
      streamed.push(page.index);
    },
    onHeaderFooter: (page, overlay) => {
      assert.equal(overlay.glyphCount, 'Footertext'.length);
      overlays.push(page.index);
    },
    onSlice: () => {
      slices++;
    },
    sliceMs: 0,
  });
  const indices = whole.pages.map((p) => p.index);
  assert.deepEqual(streamed, indices);
  assert.deepEqual(overlays, indices);
  assert.ok(slices > 100, `${slices} slices`);
  assert.deepEqual(
    result.pages.map((p) => [p.glyphCount, p.lines.length]),
    whole.pages.map((p) => [p.glyphCount, p.lines.length]),
    'streamed pages end up identical',
  );
});

test('an aborted layout rejects', skip, async () => {
  const doc = await WordDocument.create();
  doc.body = Array.from({ length: 200 }, () => paragraph([run(LOREM)]));
  const controller = new AbortController();
  await assert.rejects(
    layoutDocument(doc, fonts!, { onSlice: () => controller.abort(), sliceMs: 0, signal: controller.signal }),
    { name: 'AbortError' },
  );
});

test('encoded pages carry glyph instances as plain buffers', skip, async () => {
  const doc = await WordDocument.create();
  doc.body = Array.from({ length: 60 }, () => paragraph([run(LOREM)]));
  const reference = await layoutDocument(doc, fonts!);
  const expected = reference.pages.map((p) =>
    [...p.glyphs.values()].map((list) => [list.x(0), list.y(0), list.size(0), list.glyph(0), list.color(0), list.count]),
  );

  const encoded: ReturnType<typeof encodePage>[] = [];
  await layoutDocument(doc, fonts!, { onPage: (page) => encoded.push(encodePage(page)), mergeOverlays: false });
  assert.equal(encoded.length, reference.pages.length);
  encoded.forEach(({ page, transferables }, i) => {
    // Everything that crosses is structured-cloneable, and buffers are listed for transfer.
    const clone = structuredClone(page, { transfer: transferables });
    assert.equal(clone.text.length, expected[i].length);
    clone.text.forEach((text, k) => {
      const f32 = new Float32Array(text.instances);
      const u16 = new Uint16Array(text.instances);
      const u32 = new Uint32Array(text.instances);
      assert.ok(text.instances.byteLength >= text.count * GLYPH_INSTANCE_BYTES);
      assert.deepEqual([f32[0], f32[1], f32[2], u16[6], u32[4], text.count], expected[i][k]);
    });
    assert.ok(clone.id > 0 && clone.index === i, 'pages carry their id and position');
  });
});

test('formatting marks add a ¶ per paragraph, a dot per space and an arrow per tab, and move nothing', skip, async () => {
  const doc = await WordDocument.create();
  const run = (content: Run['content']): Run => ({ kind: 'run', properties: {}, attrs: {}, content });
  doc.body = [
    { kind: 'paragraph', properties: {}, attrs: {}, children: [run([{ kind: 'text', text: 'one two three' }, { kind: 'tab' }, { kind: 'text', text: 'x' }])] },
    { kind: 'paragraph', properties: {}, attrs: {}, children: [] },
  ];
  const glyphs = (pages: PageLayout[]) => pages.flatMap((p) => [...p.glyphs.values()].map((l) => l.count)).reduce((a, b) => a + b, 0);
  const plain = await layoutDocument(doc, fonts!);
  setFormattingMarks(true);
  try {
    const marked = await layoutDocument(doc, fonts!);
    // Two spaces (·), one tab (→) and two paragraph marks (¶, one of them on an empty paragraph).
    assert.equal(glyphs(marked.pages) - glyphs(plain.pages), 5);
    // The text itself is where it was: the same lines at the same places.
    const places = (pages: PageLayout[]) => JSON.stringify(pages.flatMap((p) => p.lines.map((l) => [l.start, l.end, l.x, l.y, l.width])));
    assert.equal(places(marked.pages), places(plain.pages));
  } finally {
    setFormattingMarks(false);
  }
  assert.equal(glyphs((await layoutDocument(doc, fonts!)).pages), glyphs(plain.pages), 'off again: as it was');
});

test('reflow lays pages out at the window width, and off again restores the page size', skip, async () => {
  const doc = await WordDocument.create();
  doc.body = [paragraph([run(LOREM.repeat(4))])];
  setReflowWidth(300);
  try {
    const { pages } = await layoutDocument(doc, fonts!);
    assert.ok(pages.every((p) => p.width === 300));
    assert.ok(pages.every((p) => p.lines.every((l) => l.x >= 24 && l.x + l.width <= 300 - 24 + 0.5)));
  } finally {
    setReflowWidth(null);
  }
  assert.equal((await layoutDocument(doc, fonts!)).pages[0].width, 612);
});

// --- Columns -----------------------------------------------------------------------------

const textParagraph = (text: string, extra: Paragraph['properties'] = {}): Paragraph => ({
  kind: 'paragraph',
  properties: extra,
  attrs: {},
  children: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text }] }],
});
const SENTENCE = 'The quick brown fox jumps over the lazy dog and keeps running through the field.';

test('a two-column section fills a column, then the next, then the next page', skip, async () => {
  const doc = await WordDocument.create();
  doc.body = Array.from({ length: 60 }, (_, i) => textParagraph(`${i}. ${SENTENCE}`));
  doc.section = { ...doc.section, columns: { num: 2, space: 720 } };
  const { pages, sections } = await layoutDocument(doc, fonts!);
  const [section] = sections;
  assert.equal(section.columns, 2);
  assert.equal(section.columnGap, 36);
  assert.equal(section.columnWidth, 216, '468pt of text, less the 36pt gap, over two');
  const first = pages[0].lines;
  const lefts = [...new Set(first.map((l) => l.column))].sort((a, b) => a - b);
  assert.deepEqual(lefts, [72, 324], 'lines start at the two columns');
  // The whole of the left column comes before the right one, both starting at the same height.
  const left = first.filter((l) => l.column === 72);
  const right = first.filter((l) => l.column === 324);
  assert.ok(left.length > 10 && right.length > 10);
  assert.equal(first.indexOf(right[0]), left.length, 'document order: the left column, then the right');
  assert.equal(left[0].y, right[0].y, 'the columns start level');
  assert.ok(right[0].y < left[left.length - 1].y, 'the right column starts back at the top');
  // Lines fit the column, not the page.
  assert.ok(first.every((l) => l.width <= 216 + 0.5));
  // More lines per page than one column would give: fewer pages than in a single column.
  const single = await WordDocument.create();
  single.body = Array.from({ length: 60 }, (_, i) => textParagraph(`${i}. ${SENTENCE}`));
  assert.ok(pages.length < (await layoutDocument(single, fonts!)).pages.length + 1);
});

test('a column break moves on to the next column, and a page break still starts a page', skip, async () => {
  const doc = await WordDocument.create();
  const run = (content: Run['content']): Run => ({ kind: 'run', properties: {}, attrs: {}, content });
  doc.body = [
    { kind: 'paragraph', properties: {}, attrs: {}, children: [run([{ kind: 'text', text: 'First' }, { kind: 'break', type: 'column' }, { kind: 'text', text: 'Second' }])] },
    { kind: 'paragraph', properties: {}, attrs: {}, children: [run([{ kind: 'text', text: 'Third' }, { kind: 'break', type: 'page' }, { kind: 'text', text: 'Fourth' }])] },
  ];
  doc.section = { ...doc.section, columns: { num: 2, space: 720 } };
  const { pages } = await layoutDocument(doc, fonts!);
  assert.equal(pages.length, 2, 'the page break began a second page');
  const on = (page: PageLayout) => page.lines.map((l) => [l.column, Math.round(l.y)]);
  // "First" ends the left column; "Second" and "Third" are at the top of the right; "Fourth" starts page 2 at the left.
  assert.deepEqual(on(pages[0]).map(([x]) => x), [72, 324, 324]);
  assert.equal(on(pages[0])[1][1], on(pages[0])[0][1], 'the right column starts level with the left');
  assert.deepEqual(on(pages[1]).map(([x]) => x), [72]);
});

test('with columns of a single column a column break is a page break', skip, async () => {
  const doc = await WordDocument.create();
  const run = (content: Run['content']): Run => ({ kind: 'run', properties: {}, attrs: {}, content });
  doc.body = [{ kind: 'paragraph', properties: {}, attrs: {}, children: [run([{ kind: 'text', text: 'A' }, { kind: 'break', type: 'column' }, { kind: 'text', text: 'B' }])] }];
  assert.equal((await layoutDocument(doc, fonts!)).pages.length, 2);
});

test('a line between the columns is drawn once per page, and only when asked for', skip, async () => {
  const make = async (sep: boolean) => {
    const doc = await WordDocument.create();
    doc.body = Array.from({ length: 60 }, (_, i) => textParagraph(`${i}. ${SENTENCE}`));
    doc.section = { ...doc.section, columns: { num: 3, space: 360, sep } };
    return (await layoutDocument(doc, fonts!)).pages;
  };
  const [without, withLine] = [await make(false), await make(true)];
  for (let p = 0; p < withLine.length; p++) assert.equal(withLine[p].foreground.count - without[p].foreground.count, 2, 'two lines between three columns');
});

test('a continuous section starts below the one before, in its own columns', skip, async () => {
  const doc = await WordDocument.create();
  const one = { ...doc.section, columns: { num: 1 } };
  doc.body = [
    textParagraph('A title long enough to run across the whole width of the page in one line', { section: { ...one } }),
    ...Array.from({ length: 8 }, (_, i) => textParagraph(`${i}. ${SENTENCE}`)),
  ];
  // The body's own (last) section: continuous, two columns.
  doc.section = { ...doc.section, type: 'continuous', columns: { num: 2, space: 720 } };
  const { pages } = await layoutDocument(doc, fonts!);
  assert.equal(pages.length, 1);
  const [title, ...rest] = pages[0].lines;
  assert.equal(title.column, 72);
  assert.ok(title.width > 216 && rest[0].y > title.y, 'the title is one line as wide as the page');
  assert.ok(rest.every((l) => l.y > title.y), 'the columns start below it');
  assert.ok(rest.every((l) => l.width <= 216 + 0.5), 'and are as narrow as columns');
});

test('an autofit table wider than its column narrows to it; a fixed one keeps its width', skip, async () => {
  const cell = (text: string) => ({ kind: 'cell' as const, properties: {}, attrs: {}, children: [textParagraph(text)] });
  const make = (layout?: 'fixed'): Table => ({ kind: 'table', properties: layout ? { layout } : {}, grid: [4680, 4680], rows: [{ kind: 'row', properties: {}, attrs: {}, cells: [cell('a'), cell('b')] }] });
  const widthOf = async (table: Table, columns: number) => {
    const doc = await WordDocument.create();
    doc.body = [table, textParagraph('after')];
    doc.section = { ...doc.section, columns: { num: columns, space: 720 } };
    const { pages } = await layoutDocument(doc, fonts!);
    const xs = pages[0].lines.filter((l) => paragraphTextOf(l.paragraph) === 'b').map((l) => l.column);
    return xs[0];
  };
  const paragraphTextOf = (p: Paragraph) => (p.children as Run[]).map((r) => r.content.map((c) => (c.kind === 'text' ? c.text : '')).join('')).join('');
  // The second cell starts half way across: at the middle of the page (72 + 234), or of the column (72 + 108).
  assert.ok(Math.abs((await widthOf(make(), 1)) - (72 + 234)) < 6);
  assert.ok(Math.abs((await widthOf(make(), 2)) - (72 + 108)) < 6, 'shrunk to the 216pt column');
  assert.ok((await widthOf(make('fixed'), 2)) > 72 + 200, 'a fixed table is left as it was');
});

test('a floating text box is drawn at its place on the page, apart from the text flow', skip, async () => {
  const { el } = await import('@golemdocs/docx');
  const doc = await WordDocument.create();
  const cx = String(200 * 12700);
  const cy = String(40 * 12700);
  const anchor = el('wp:anchor', { simplePos: 0, relativeHeight: 1, behindDoc: 0, allowOverlap: 1 }, [
    el('wp:simplePos', { x: 0, y: 0 }),
    el('wp:positionH', { relativeFrom: 'page' }, [el('wp:posOffset', {}, [String(100 * 12700)])]),
    el('wp:positionV', { relativeFrom: 'page' }, [el('wp:posOffset', {}, [String(300 * 12700)])]),
    el('wp:extent', { cx, cy }),
    el('wp:wrapNone'),
    el('wp:docPr', { id: 1, name: 'Box' }),
    el('a:graphic', {}, [el('a:graphicData', {}, [el('wps:wsp', {}, [el('wps:txbx', {}, [el('w:txbxContent')]), el('wps:bodyPr', { lIns: 0, tIns: 0, rIns: 0, bIns: 0 })])])]),
  ]);
  const drawing = { kind: 'drawing' as const, inline: false, width: 200 * 12700, height: 40 * 12700, xml: el('w:drawing', {}, [anchor]), textBox: [paragraph([run('Boxed')])] };
  doc.body = [paragraph([run('Body text'), { kind: 'run', properties: {}, content: [drawing], attrs: {} }])];
  const layout = await layoutDocument(doc, fonts!);
  const page = layout.pages[0];
  // Only the body's line is recorded; the box's glyphs are on the page too, 300pt down and 100pt across.
  assert.equal(page.lines.length, 1);
  let boxed = 0;
  for (const list of page.glyphs.values()) {
    for (let i = 0; i < list.count; i++) if (list.y(i) > 300 && list.y(i) < 340 && list.x(i) >= 100 && list.x(i) < 300) boxed++;
  }
  assert.equal(boxed, 5);
});
