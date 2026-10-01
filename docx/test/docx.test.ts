import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WordDocument } from '../src/docx/document.ts';
import { ListCounter, formatNumber } from '../src/model/lists.ts';
import { StyleResolver } from '../src/model/resolve.ts';
import type { Block, Paragraph, Run, Table } from '../src/model/types.ts';
import { CORPUS_DIR as CORPUS, corpusFiles } from './corpus.ts';
import { roundTrip } from './roundtrip.ts';
import { readDrawing } from '../src/docx/content.ts';
import { readStyles } from '../src/docx/styles.ts';
import { Relationships } from '../src/opc/package.ts';
import { parseXml } from '../src/xml/xml.ts';

const files = corpusFiles();

test('every readable corpus document round-trips without changes', files ? {} : { skip: 'run `pnpm --filter @golemdocs/docx corpus` first' }, async () => {
  const failures: string[] = [];
  let readable = 0;
  for (const file of files ?? []) {
    const result = await roundTrip(file, readFileSync(path.join(CORPUS, file)));
    if (result.error?.startsWith('read:')) continue;
    readable++;
    // 56392.docx has style children out of schema order; the writer deliberately fixes that.
    const diffs = result.diffs.filter((d) => !(file === '56392.docx' && d.part === 'word/styles.xml'));
    if (result.error || diffs.length) failures.push(`${file}: ${result.error ?? diffs[0].part + ' ' + diffs[0].diff}`);
  }
  assert.ok(readable >= 114, `only ${readable} readable documents`);
  assert.deepEqual(failures, []);
});

const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

const text = (t: string, properties: Run['properties'] = {}): Run => ({
  kind: 'run',
  properties,
  content: [{ kind: 'text', text: t }],
  attrs: {},
});
const paragraph = (children: Paragraph['children'], properties: Paragraph['properties'] = {}): Paragraph => ({
  kind: 'paragraph',
  properties,
  children,
  attrs: {},
});

export async function buildSampleDocument(): Promise<WordDocument> {
  const doc = await WordDocument.create();
  const image = doc.addImage(PNG_1X1, 'png');
  const header = doc.addHeaderFooter('header');
  header.children = [paragraph([text('Sample header')])];
  const footer = doc.addHeaderFooter('footer');
  footer.children = [paragraph([text('Sample footer')], { justification: 'center' })];
  doc.section.headers.push({ type: 'default', part: header.part });
  doc.section.footers.push({ type: 'default', part: footer.part });

  doc.numbering.abstracts.push({
    id: 0,
    multiLevelType: 'hybridMultilevel',
    levels: [0, 1].map((level) => ({
      level,
      start: 1,
      format: level === 0 ? 'decimal' : 'lowerLetter',
      text: `%${level + 1}.`,
      justification: 'left',
      paragraphProperties: { indent: { left: 720 * (level + 1), hanging: 360 } },
      attrs: {},
    })),
    attrs: {},
  });
  doc.numbering.instances.push({ id: 1, abstractId: 0, overrides: [], attrs: {} });

  const table: Table = {
    kind: 'table',
    properties: { style: 'TableGrid', width: { w: '0', type: 'auto' }, look: { val: '04A0', firstRow: true } },
    grid: [4680, 4680],
    rows: [0, 1].map((r) => ({
      kind: 'row',
      properties: {},
      attrs: {},
      cells: [0, 1].map((c) => ({
        kind: 'cell',
        properties: { width: { w: '4680', type: 'dxa' } },
        children: [paragraph([text(`Cell ${r}-${c}`, r === 0 ? { bold: true } : {})])],
        attrs: {},
      })),
    })),
  };

  doc.body = [
    paragraph([text('Round-trip sample')], { style: 'Title' }),
    paragraph([text('Heading one')], { style: 'Heading1' }),
    paragraph([
      text('Plain, '),
      text('bold', { bold: true }),
      text(', '),
      text('italic 14pt red', { italic: true, size: 28, color: { val: 'FF0000' } }),
      text(' and a '),
      { kind: 'hyperlink', url: 'https://example.com/', children: [text('link', { style: 'Hyperlink' })], attrs: {} },
      text('.'),
    ]),
    paragraph([text('First item')], { style: 'ListParagraph', numbering: { id: 1, level: 0 } }),
    paragraph([text('Nested item')], { style: 'ListParagraph', numbering: { id: 1, level: 1 } }),
    paragraph([text('Second item')], { style: 'ListParagraph', numbering: { id: 1, level: 0 } }),
    table,
    paragraph([
      text('Picture: '),
      {
        kind: 'run',
        properties: {},
        attrs: {},
        content: [{ kind: 'drawing', inline: true, width: 914400, height: 914400, image, description: 'A pixel' }],
      },
    ]),
  ];
  return doc;
}

const blockText = (blocks: Block[]): string[] =>
  blocks.flatMap((b) => {
    if (b.kind === 'paragraph') {
      return [
        b.children
          .flatMap((i) => (i.kind === 'run' ? [i] : i.kind === 'hyperlink' ? i.children.filter((c) => c.kind === 'run') : []))
          .flatMap((r) => (r as Run).content)
          .map((c) => (c.kind === 'text' ? c.text : ''))
          .join(''),
      ];
    }
    if (b.kind === 'table') {
      return b.rows.flatMap((r) => (r.kind === 'row' ? r.cells.flatMap((c) => (c.kind === 'cell' ? blockText(c.children) : [])) : []));
    }
    return [];
  });

test('a document built from scratch survives write and read', async () => {
  const doc = await buildSampleDocument();
  const again = await WordDocument.read(await doc.write());
  assert.deepEqual(blockText(again.body), [
    'Round-trip sample',
    'Heading one',
    'Plain, bold, italic 14pt red and a link.',
    'First item',
    'Nested item',
    'Second item',
    'Cell 0-0',
    'Cell 0-1',
    'Cell 1-0',
    'Cell 1-1',
    'Picture: ',
  ]);

  const link = (again.body[2] as Paragraph).children[5];
  assert.equal(link.kind === 'hyperlink' && link.url, 'https://example.com/');
  const drawing = ((again.body[7] as Paragraph).children[1] as Run).content[0];
  assert.equal(drawing.kind, 'drawing');
  assert.deepEqual(await again.media(drawing.kind === 'drawing' ? drawing.image! : ''), PNG_1X1);
  assert.equal(again.section.headers.length, 1);
  assert.deepEqual(blockText(again.headersFooters.get(again.section.headers[0].part)!.children), ['Sample header']);
  assert.equal(again.section.pageSize?.w, 12240);

  // Writing the re-read document again is stable.
  const third = await WordDocument.read(await again.write());
  assert.deepEqual(blockText(third.body), blockText(again.body));
});

test('style resolution: defaults, style chain, direct formatting and toggles', async () => {
  const doc = await buildSampleDocument();
  const resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
  const body = resolver.paragraph({});
  assert.equal(body.style, 'Normal');
  assert.equal(body.spacing?.after, 160);
  const heading = resolver.paragraph({ style: 'Heading1' });
  assert.equal(heading.keepNext, true);
  assert.equal(heading.spacing?.before, 240);
  assert.equal(heading.spacing?.line, 259, 'spacing merges field by field with docDefaults');
  const run = resolver.run('Heading1', { bold: true });
  assert.equal(run.size, 32);
  assert.equal(resolver.font(run.fonts), 'Calibri Light');
  assert.equal(run.bold, true);
  const listItem = resolver.paragraph({ style: 'ListParagraph', numbering: { id: 1, level: 1 } });
  assert.equal(listItem.indent?.left, 1440, 'numbering level indentation applies over the style');
});

test('list labels', async () => {
  const doc = await buildSampleDocument();
  const resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
  const counter = new ListCounter(resolver);
  const labels = [0, 1, 1, 0, 1].map((level) => counter.next({ id: 1, level })?.text);
  assert.deepEqual(labels, ['1.', 'a.', 'b.', '2.', 'a.']);
  assert.equal(formatNumber(1994, 'upperRoman'), 'MCMXCIV');
  assert.equal(formatNumber(28, 'lowerLetter'), 'bb');
  assert.equal(formatNumber(23, 'ordinal'), '23rd');
});

test('huge list numbers fall back to digits instead of spelling out millions of letters', () => {
  assert.equal(formatNumber(32767, 'upperRoman').startsWith('MMMMM'), true);
  assert.equal(formatNumber(2_000_000_000, 'lowerLetter'), '2000000000');
  assert.equal(formatNumber(2_000_000_000, 'lowerRoman'), '2000000000');
});

test('a drawing without a numeric size is kept as it is, not modeled with NaN', () => {
  const ctx = { rels: new Relationships('word/document.xml', []) };
  const drawing = (extent: string) =>
    readDrawing(parseXml(`<w:drawing xmlns:w="w" xmlns:wp="wp"><wp:inline>${extent}<wp:docPr id="1" name="x"/></wp:inline></w:drawing>`), ctx);
  assert.equal(drawing('<wp:extent/>').kind, 'raw');
  assert.equal(drawing('<wp:extent cx="abc" cy="10"/>').kind, 'raw');
  const ok = drawing('<wp:extent cx="20" cy="10"/>');
  assert.equal(ok.kind === 'drawing' && ok.width, 20);
});

test('a table style condition without a type is preserved rather than written without one', () => {
  const ctx = { rels: new Relationships('word/styles.xml', []) };
  const sheet = readStyles(
    parseXml('<w:styles xmlns:w="w"><w:style w:type="table" w:styleId="T"><w:tblStylePr w:other="1"><w:rPr><w:b/></w:rPr></w:tblStylePr><w:tblStylePr w:type="firstRow"/></w:style></w:styles>'),
    ctx,
  );
  const style = sheet.styles[0];
  assert.deepEqual(style.tableConditions?.map((c) => c.type), ['firstRow']);
  assert.equal(style.extra?.length, 1);
});
