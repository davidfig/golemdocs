import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WordDocument, type Paragraph, type Run, type Table } from '@word/docx';
import { encodePage, FontSet, GLYPH_INSTANCE_BYTES, layoutDocument } from '../src/index.ts';

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
