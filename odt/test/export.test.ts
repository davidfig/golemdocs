import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphsIn, paragraphText, WordDocument, type Block, type Paragraph, type Run } from '@word/docx';
import { readOdt, writeOdt } from '../src/index.ts';
import { readTextProperties, writeBorder, writeTextProperties } from '../src/properties.ts';
import { libreOfficeFixture, PNG_1X1 } from './fixtures.ts';
import { find, textOf, validateOdt } from './validate.ts';

const run = (text: string, properties: Run['properties'] = {}): Run => ({ kind: 'run', properties, content: [{ kind: 'text', text }], attrs: {} });
const para = (properties: Paragraph['properties'], ...children: Paragraph['children']): Paragraph => ({ kind: 'paragraph', properties, children, attrs: {} });

/** A document made the way the app makes one: WordDocument.create() plus content. */
async function wordDocument(): Promise<WordDocument> {
  const doc = await WordDocument.create();
  const image = doc.addImage(PNG_1X1, 'png');
  doc.numbering.abstracts.push({
    id: 0,
    levels: [0, 1].map((level) => ({
      level,
      format: level ? 'lowerLetter' : 'decimal',
      text: level ? '%1.%2.' : '%1.',
      start: 1,
      suffix: 'tab' as const,
      paragraphProperties: { indent: { left: 720 * (level + 1), hanging: 360 } },
      attrs: {},
    })),
    attrs: {},
  });
  doc.numbering.instances.push({ id: 1, abstractId: 0, overrides: [], attrs: {} });
  const body: Block[] = [
    para({ style: 'Title' }, run('A Word document')),
    para({ style: 'Heading1' }, run('Introduction')),
    para({ justification: 'both', spacing: { before: 120, after: 240, line: 360, lineRule: 'auto' }, indent: { left: 360, firstLine: 360 } }, run('Justified with '), run('bold', { bold: true }), run(' and '), run('colored', { color: { val: 'FF0000' }, size: 28 }), run('  two spaces')),
    para({ numbering: { id: 1, level: 0 } }, run('first')),
    para({ numbering: { id: 1, level: 1 } }, run('nested')),
    para({ numbering: { id: 1, level: 0 } }, run('second')),
    para({}, { kind: 'hyperlink', url: 'https://example.org/', attrs: {}, children: [run('a link', { style: 'Hyperlink' })] }, { kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'tab' }, { kind: 'text', text: 'x' }, { kind: 'break' }, { kind: 'text', text: 'y' }] }),
    para({}, { kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'drawing', inline: true, width: 914400, height: 457200, image, name: 'Logo', description: 'The logo' }] }),
    {
      kind: 'table',
      properties: { style: 'TableGrid' },
      grid: [3000, 3000, 3360],
      rows: [
        { kind: 'row', properties: { header: true }, attrs: {}, cells: ['A', 'B', 'C'].map((t) => ({ kind: 'cell' as const, properties: {}, attrs: {}, children: [para({}, run(t))] })) },
        {
          kind: 'row',
          properties: {},
          attrs: {},
          cells: [
            { kind: 'cell', properties: { gridSpan: 2, vMerge: 'restart' }, attrs: {}, children: [para({}, run('wide and tall'))] },
            { kind: 'cell', properties: {}, attrs: {}, children: [para({}, run('c2'))] },
          ],
        },
        {
          kind: 'row',
          properties: {},
          attrs: {},
          cells: [
            { kind: 'cell', properties: { gridSpan: 2, vMerge: 'continue' }, attrs: {}, children: [para({})] },
            { kind: 'cell', properties: { shading: { val: 'clear', fill: 'EEEEEE' } }, attrs: {}, children: [para({}, run('c3'))] },
          ],
        },
      ],
    },
    para({ pageBreakBefore: true }, run('After a page break')),
  ];
  body.forEach((b, i) => {
    if (b.kind === 'paragraph') b.attrs['w14:paraId'] = (i + 1).toString(16).toUpperCase().padStart(8, '0');
  });
  doc.body = body;
  const footer = doc.addHeaderFooter('footer');
  footer.children = [
    para({ justification: 'center' }, {
      kind: 'run',
      properties: {},
      attrs: {},
      content: [
        { kind: 'text', text: 'Page ' },
        { kind: 'fieldChar', type: 'begin', xml: { name: 'w:fldChar', attrs: { 'w:fldCharType': 'begin' }, children: [] } },
        { kind: 'instrText', text: ' PAGE ' },
        { kind: 'fieldChar', type: 'separate', xml: { name: 'w:fldChar', attrs: { 'w:fldCharType': 'separate' }, children: [] } },
        { kind: 'text', text: '1' },
        { kind: 'fieldChar', type: 'end', xml: { name: 'w:fldChar', attrs: { 'w:fldCharType': 'end' }, children: [] } },
      ],
    }),
  ];
  doc.section.footers.push({ type: 'default', part: footer.part });
  return doc;
}

test('a Word document exports to a valid, sensible ODT', async () => {
  const bytes = await writeOdt(await wordDocument());
  const { content, styles, files, text } = await validateOdt(bytes);

  // Styles: Word's defaults and built-in styles under LibreOffice's names.
  const defaults = find(styles, 'style:default-style')[0];
  const defaultText = find(defaults, 'style:text-properties')[0];
  assert.equal(defaultText.attrs['style:font-name'], 'Calibri');
  assert.equal(defaultText.attrs['fo:font-size'], '11pt');
  assert.equal(find(defaults, 'style:paragraph-properties')[0].attrs['fo:line-height'], '108%');
  const common = new Map(find(styles, 'style:style').map((s) => [s.attrs['style:name'], s]));
  assert.ok(common.has('Standard'));
  assert.equal(common.get('Heading_20_1')?.attrs['style:display-name'], 'Heading 1');
  assert.equal(common.get('Heading_20_1')?.attrs['style:default-outline-level'], '1');
  assert.equal(common.get('Internet_20_link')?.attrs['style:family'], 'text');
  assert.ok(!common.has('Table_20_Grid'), 'table styles are resolved into cells, not exported');

  // Page layout: US Letter, 1" margins, footer below the body.
  const layout = find(styles, 'style:page-layout-properties')[0].attrs;
  assert.equal(layout['fo:page-width'], '8.5in');
  assert.equal(layout['fo:page-height'], '11in');
  assert.equal(layout['fo:margin-left'], '1in');
  assert.equal(layout['fo:margin-bottom'], '0.5in');
  const footer = find(styles, 'style:footer')[0];
  assert.ok(find(footer, 'text:page-number').length === 1);
  assert.equal(textOf(footer), 'Page 1');

  // Body.
  const body = find(content, 'office:text')[0];
  const [title, heading] = find(body, 'text:p').concat(find(body, 'text:h')).filter((e) => ['A Word document', 'Introduction'].includes(textOf(e)));
  assert.equal(title.attrs['text:style-name'], 'Title');
  assert.equal(heading.name, 'text:h');
  assert.equal(heading.attrs['text:outline-level'], '1');
  assert.equal(heading.attrs['xml:id'], 'para-00000002');
  const justified = find(body, 'text:p').find((e) => textOf(e).startsWith('Justified'))!;
  const auto = find(content, 'style:style').find((s) => s.attrs['style:name'] === justified.attrs['text:style-name'])!;
  const pp = find(auto, 'style:paragraph-properties')[0].attrs;
  assert.equal(pp['fo:text-align'], 'justify');
  assert.equal(pp['fo:line-height'], '150%');
  assert.equal(pp['fo:margin-top'], '0.0833in');
  assert.equal(pp['fo:text-indent'], '0.25in');
  assert.equal(find(justified, 'text:s').length, 1, 'the second of two spaces is protected');

  const lists = find(body, 'text:list').filter((l) => l.attrs['text:style-name']);
  assert.equal(lists.length, 1);
  assert.equal(find(lists[0], 'text:list').length, 2, 'the list and, inside it, level 2');
  const listStyle = find(content, 'text:list-style')[0];
  const level1 = find(listStyle, 'text:list-level-style-number')[0];
  assert.deepEqual([level1.attrs['style:num-format'], level1.attrs['style:num-suffix']], ['1', '.']);
  const level2 = find(listStyle, 'text:list-level-style-number')[1];
  assert.deepEqual([level2.attrs['style:num-format'], level2.attrs['text:display-levels']], ['a', '2']);

  const link = find(body, 'text:a')[0];
  assert.equal(link.attrs['xlink:href'], 'https://example.org/');
  assert.equal(link.attrs['text:style-name'], 'Internet_20_link');
  assert.ok(find(body, 'text:tab').length && find(body, 'text:line-break').length);

  const frame = find(body, 'draw:frame')[0];
  assert.equal(frame.attrs['svg:width'], '25.4mm');
  assert.equal(frame.attrs['text:anchor-type'], 'as-char');
  const href = find(frame, 'draw:image')[0].attrs['xlink:href'];
  assert.deepEqual(files.get(href), PNG_1X1);
  assert.match(text.get('META-INF/manifest.xml')!, new RegExp(`full-path="${href}" manifest:media-type="image/png"`));

  const table = find(body, 'table:table')[0];
  assert.equal(find(table, 'table:table-column').length, 3);
  assert.equal(find(table, 'table:table-header-rows').length, 1);
  const spanning = find(table, 'table:table-cell').find((c) => textOf(c) === 'wide and tall')!;
  assert.equal(spanning.attrs['table:number-columns-spanned'], '2');
  assert.equal(spanning.attrs['table:number-rows-spanned'], '2');
  assert.equal(find(table, 'table:covered-table-cell').length, 3);
  const cellStyle = find(content, 'style:style').find((s) => s.attrs['style:name'] === spanning.attrs['table:style-name'])!;
  assert.equal(find(cellStyle, 'style:table-cell-properties')[0].attrs['fo:border-top'], '0.5pt solid #000000', 'Table Grid borders');
  // Table Grid's paragraph spacing applies to its cells.
  const cellPara = find(spanning, 'text:p')[0];
  const cellParaStyle = find(content, 'style:style').find((s) => s.attrs['style:name'] === cellPara.attrs['text:style-name'])!;
  assert.equal(find(cellParaStyle, 'style:paragraph-properties')[0].attrs['fo:margin-bottom'], '0in');

  const broken = find(body, 'text:p').find((e) => textOf(e) === 'After a page break')!;
  const brokenStyle = find(content, 'style:style').find((s) => s.attrs['style:name'] === broken.attrs['text:style-name'])!;
  assert.equal(find(brokenStyle, 'style:paragraph-properties')[0].attrs['fo:break-before'], 'page');

  assert.match(text.get('meta.xml')!, /<meta:generator>/);
  assert.ok(!files.has('settings.xml'), 'no settings unless the extension has them');
});

test('a Word document survives export and import', async () => {
  const doc = await wordDocument();
  const { document } = await readOdt(await writeOdt(doc));
  const paragraphs = paragraphsIn(document.body);
  const before = paragraphsIn(doc.body);
  // Same text and same ids for every paragraph that had one.
  for (const p of before) {
    const id = p.attrs['w14:paraId'];
    if (!id) continue;
    const again = paragraphs.find((q) => q.attrs['w14:paraId'] === id);
    assert.ok(again, `paragraph ${id} kept its id`);
    assert.equal(paragraphText(again).replace(/￼/g, ''), paragraphText(p).replace(/￼/g, ''));
  }
  const justified = paragraphs.find((p) => paragraphText(p).startsWith('Justified'))!;
  assert.deepEqual(justified.properties.spacing, { before: 120, after: 240, line: 360, lineRule: 'auto' });
  assert.deepEqual(justified.properties.indent, { left: 360, firstLine: 360 });
  assert.equal(justified.properties.justification, 'both');
  const colored = justified.children.find((r) => r.kind === 'run' && r.content.some((c) => c.kind === 'text' && c.text === 'colored')) as Run;
  assert.deepEqual(colored.properties, { color: { val: 'FF0000' }, size: 28 });
  assert.equal(paragraphs.find((p) => paragraphText(p) === 'nested')!.properties.numbering?.level, 1);
  assert.equal(document.styles.styles.find((s) => s.id === 'Heading1')?.runProperties?.color?.val, '2F5496');
  assert.deepEqual(document.section.pageSize, { w: 12240, h: 15840 });
  assert.deepEqual(
    [document.section.margins?.top, document.section.margins?.bottom, document.section.margins?.footer],
    [1440, 1440, 720],
  );
});

test('LibreOffice-style input exports to a valid package', async () => {
  const { document, extension } = await readOdt(await libreOfficeFixture());
  const { content, styles, files } = await validateOdt(await writeOdt(document, extension));
  // Preserved pieces are back, with their automatic styles renamed but resolvable.
  assert.equal(find(content, 'office:annotation').length, 1);
  assert.equal(find(content, 'office:annotation-end').length, 1);
  assert.equal(find(content, 'text:bookmark-start').length, 1);
  assert.equal(find(content, 'text:date').length, 1);
  assert.equal(find(content, 'text:note').length, 1);
  assert.equal(find(content, 'text:section').length, 1);
  assert.equal(find(content, 'text:sequence-decls').length, 1);
  assert.equal(find(find(content, 'office:text')[0], 'draw:frame').length, 2);
  assert.equal(find(styles, 'text:outline-style').length, 1);
  assert.equal(find(styles, 'style:footnote-sep').length, 1);
  assert.ok([...files.keys()].some((f) => f.startsWith('Pictures/')));
  // Continued list.
  const continued = find(content, 'text:list').find((l) => l.attrs['text:continue-list']);
  assert.ok(continued);
  assert.ok(find(content, 'text:list').some((l) => l.attrs['xml:id'] === continued.attrs['text:continue-list']));
});

test('language tags with a script keep script and region apart', () => {
  const written = writeTextProperties({ lang: { val: 'sr-Latn-RS', eastAsia: 'zh-Hans', bidi: 'ar-EG' } }, () => undefined);
  assert.equal(written['fo:language'], 'sr');
  assert.equal(written['fo:script'], 'Latn');
  assert.equal(written['fo:country'], 'RS');
  assert.equal(written['style:script-asian'], 'Hans');
  assert.equal(written['style:country-asian'], 'none', 'a script is not a country');
  assert.equal(written['style:country-complex'], 'EG');
  const e = { name: 'style:text-properties', attrs: written, children: [] };
  assert.deepEqual(readTextProperties(e, { fonts: new Map(), baseSize: 24 }).run.lang, { val: 'sr-Latn-RS', eastAsia: 'zh-Hans', bidi: 'ar-EG' });
});

test('colors that are not hex are written as valid ODF colors', () => {
  assert.equal(writeBorder({ val: 'single', sz: 8, color: 'auto' }), '1pt solid #000000');
  assert.equal(writeBorder({ val: 'single', sz: 8, color: 'red" x="1' }), '1pt solid #000000');
  assert.equal(writeTextProperties({ underline: { val: 'single', color: 'auto' } }, () => undefined)['style:text-underline-color'], 'font-color');
});

test('extension content cannot declare reserved prefixes or write files outside the package', async () => {
  const doc = await WordDocument.create();
  doc.body = [{ kind: 'paragraph', properties: {}, children: [run('x')], attrs: { 'w14:paraId': '00000001' } }];
  const png = btoa(String.fromCharCode(...PNG_1X1));
  const bytes = await writeOdt(doc, {
    version: 1,
    namespaces: { xmlfoo: 'urn:bad', good: 'urn:good' },
    objects: [
      {
        placement: 'inline',
        paragraphId: '00000001',
        offset: 0,
        fragment: { xml: '<draw:frame><draw:image xlink:href="Pictures/ok.png"/></draw:frame>', media: { '../evil.png': png, '/abs.png': png, 'Pictures/ok.png': png } },
      },
    ],
  });
  const { content, files } = await validateOdt(bytes);
  assert.equal(content.attrs['xmlns:xmlfoo'], undefined);
  assert.equal(content.attrs['xmlns:good'], 'urn:good');
  assert.ok(files.has('Pictures/ok.png'));
  assert.ok(![...files.keys()].some((f) => f.includes('..') || f.startsWith('/')), [...files.keys()].join(', '));
});

test('paragraphs sharing an id do not repeat an xml:id', async () => {
  const doc = await WordDocument.create();
  doc.body = [
    { kind: 'paragraph', properties: {}, children: [run('one')], attrs: { 'w14:paraId': '0000000A' } },
    { kind: 'paragraph', properties: {}, children: [run('two')], attrs: { 'w14:paraId': '0000000A' } },
  ];
  const bytes = await writeOdt(doc);
  const { content } = await validateOdt(bytes);
  assert.deepEqual(find(content, 'text:p').map((p) => p.attrs['xml:id']), ['para-0000000A', undefined]);
  const again = paragraphsIn((await readOdt(bytes)).document.body).map((p) => p.attrs['w14:paraId']);
  assert.equal(new Set(again).size, 2);
});
