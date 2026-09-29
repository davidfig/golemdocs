import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphsIn, paragraphText, StyleResolver, type Hyperlink, type Paragraph, type Run, type Table, type TableCell, type TableRow } from '@word/docx';
import { readOdt } from '../src/index.ts';
import { libreOfficeFixture, minimalContent, odtPackage } from './fixtures.ts';

const runs = (p: Paragraph): Run[] => {
  const out: Run[] = [];
  const visit = (inlines: Paragraph['children']) => {
    for (const i of inlines) {
      if (i.kind === 'run') out.push(i);
      else if (i.kind === 'hyperlink' || i.kind === 'wrapper') visit(i.children);
    }
  };
  visit(p.children);
  return out;
};
const runText = (r: Run) => r.content.map((c) => (c.kind === 'text' ? c.text : '')).join('');
const runWith = (p: Paragraph, text: string) => runs(p).find((r) => runText(r) === text);
const byText = (paragraphs: Paragraph[], start: string) => paragraphs.find((p) => paragraphText(p).startsWith(start))!;

async function fixture() {
  const { document, extension } = await readOdt(await libreOfficeFixture());
  return { document, extension, paragraphs: paragraphsIn(document.body) };
}

test('every paragraph gets a unique sequential paragraph id', async () => {
  const { document, paragraphs } = await fixture();
  const all = [...paragraphs, ...[...document.headersFooters.values()].flatMap((hf) => paragraphsIn(hf.children))];
  const ids = all.map((p) => p.attrs['w14:paraId']);
  assert.ok(ids.every((id) => /^[0-9A-F]{8}$/.test(id) && parseInt(id, 16) < 0x80000000));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], '00000001');
  assert.deepEqual(
    [...ids].sort(),
    ids.map((_, i) => (i + 1).toString(16).toUpperCase().padStart(8, '0')),
  );
});

test('styles map to Word styles with inheritance and resolved sizes', async () => {
  const { document } = await fixture();
  const style = (id: string) => document.styles.styles.find((s) => s.id === id)!;
  // Built-in LibreOffice names become Word's built-in ids.
  assert.ok(style('Normal').isDefault);
  assert.equal(style('Heading1').basedOn, 'Heading');
  assert.equal(style('Heading1').next, 'BodyText');
  assert.equal(style('Heading1').paragraphProperties?.outlineLevel, 0);
  assert.equal(style('Heading1').runProperties?.bold, true);
  assert.equal(style('Heading1').runProperties?.size, 36); // 130% of 14pt = 18.2pt
  assert.equal(style('Heading2').runProperties?.size, 32); // 115% of 14pt
  assert.equal(style('BodyText').name, 'Body Text');
  assert.deepEqual(style('BodyText').paragraphProperties?.spacing, { before: 0, after: 140, line: 276, lineRule: 'auto' });
  assert.deepEqual(style('Quote').paragraphProperties?.indent, { left: 567, right: 567, firstLine: 0 });
  assert.equal(style('Hyperlink').runProperties?.color?.val, '000080');
  assert.equal(style('Strong').type, 'character');
  assert.equal(style('SourceText').runProperties?.fonts?.ascii, 'DejaVu Sans Mono');
  assert.equal(style('TableContents').name, 'Table Contents');
  // The paragraph default style becomes the document defaults (ODF's, not Word's).
  assert.equal(document.styles.defaultRunProperties?.size, 24);
  assert.equal(document.styles.defaultRunProperties?.fonts?.ascii, 'Liberation Serif');
  assert.equal(document.styles.defaultRunProperties?.lang?.val, 'en-US');
  assert.equal(document.styles.defaultParagraphProperties?.spacing, undefined);
  assert.equal(document.settings.defaultTabStop, 709);
});

test('headings, paragraph formatting and automatic text styles', async () => {
  const { document, paragraphs } = await fixture();
  const heading = paragraphs[0];
  assert.equal(heading.properties.style, 'Heading1');
  assert.equal(heading.properties.pageBreakBefore, undefined, 'the first page style is not a break');
  assert.equal(runWith(heading, 'Title')?.properties.bold, true);

  const centered = byText(paragraphs, 'Centered');
  assert.equal(centered.properties.justification, 'center');
  assert.equal(paragraphText(centered).slice(0, 13), 'Centered and ', 'runs of spaces collapse');
  assert.deepEqual(runWith(centered, 'italic underlined')?.properties, { italic: true, underline: { val: 'single' } });
  assert.deepEqual(runWith(centered, 'red struck highlighted')?.properties, {
    strike: true,
    color: { val: 'C9211E' },
    shading: { val: 'clear', color: 'auto', fill: 'FFFF00' },
  });
  const sup = runs(centered).filter((r) => runText(r) === '2');
  assert.equal(sup[0].properties.vertAlign, 'superscript');
  assert.equal(sup[1].properties.vertAlign, 'subscript');
  assert.equal(sup[1].properties.fonts?.ascii, 'DejaVu Sans Mono');
  assert.equal(sup[1].properties.size, 36, '150% of the 12pt paragraph');

  const hanging = byText(paragraphs, 'Indented');
  assert.equal(hanging.properties.style, 'BodyText');
  assert.deepEqual(hanging.properties.indent, { left: 720, hanging: 360 });
  assert.deepEqual(hanging.properties.spacing, { line: 360, lineRule: 'auto' });

  // A paragraph's automatic text properties format all its runs.
  const small = byText(paragraphs, 'Small sans');
  assert.ok(runs(small).every((r) => r.properties.size === 20 && r.properties.fonts?.ascii === 'Liberation Sans'));
  assert.ok(document.body.length > 10);
});

test('spaces, tabs, line breaks and soft page breaks', async () => {
  const { paragraphs } = await fixture();
  const p = byText(paragraphs, 'Spaces:');
  const items = runs(p).flatMap((r) => r.content.map((c) => (c.kind === 'text' ? c.text : `<${c.kind}>`)));
  assert.equal(items.join(''), 'Spaces:   three<tab>tab<break>new line strong after soft break.');
  assert.equal(runWith(p, 'strong')?.properties.style, 'Strong');
});

test('hyperlinks, internal links and the link character style', async () => {
  const { paragraphs } = await fixture();
  const p = byText(paragraphs, 'Indented');
  const links = p.children.filter((c): c is Hyperlink => c.kind === 'hyperlink');
  assert.equal(links[0].url, 'https://example.com/a?b=1&c=2');
  assert.deepEqual(
    links[0].children.map((r) => (r as Run).properties),
    [{ style: 'Hyperlink' }, { style: 'Hyperlink', bold: true, boldCs: true }],
  );
  assert.equal(links[1].anchor, 'Target');
  assert.equal(links[1].url, undefined);
});

test('lists become numbering with levels, start values and continuation', async () => {
  const { document, paragraphs } = await fixture();
  const numbering = (text: string) => byText(paragraphs, text).properties.numbering;
  const first = numbering('First bullet')!;
  assert.deepEqual(numbering('Nested bullet'), { id: first.id, level: 1 });
  assert.deepEqual(numbering('Second bullet'), { id: first.id, level: 0 });
  // A further paragraph in an item is unnumbered, lined up with the item's text.
  const continuation = byText(paragraphs, 'Continuation');
  assert.equal(continuation.properties.numbering, undefined);
  assert.equal(continuation.properties.indent?.left, 360);

  const three = numbering('Three')!;
  assert.notEqual(three.id, first.id);
  assert.deepEqual(numbering('Three a'), { id: three.id, level: 1 });
  assert.deepEqual(numbering('Five'), { id: three.id, level: 0 }, 'text:continue-list continues the list');

  const resolver = new StyleResolver(document.styles, document.theme, document.numbering);
  const bullet = resolver.listLevel(first.id, 0)!;
  assert.equal(bullet.format, 'bullet');
  assert.equal(bullet.text, '•');
  assert.equal(resolver.listLevel(first.id, 1)!.text, '◦');
  const number = resolver.listLevel(three.id, 0)!;
  assert.deepEqual([number.format, number.text, number.start, number.suffix], ['decimal', '%1.', 3, 'tab']);
  assert.deepEqual(number.paragraphProperties?.indent, { left: 720, hanging: 360 });
  const sub = resolver.listLevel(three.id, 1)!;
  assert.deepEqual([sub.format, sub.text, sub.suffix], ['lowerLetter', '%1.%2)', 'space']);
});

test('tables: columns, header rows, cell formatting, column and row spans', async () => {
  const { document } = await fixture();
  const table = document.body.find((b): b is Table => b.kind === 'table')!;
  assert.deepEqual(table.grid, [2835, 6803]);
  assert.deepEqual(table.properties.width, { w: '9638', type: 'dxa' });
  const rows = table.rows as TableRow[];
  const cells = (r: number) => rows[r].cells as TableCell[];
  assert.equal(rows[0].properties.header, true);
  assert.equal(cells(0)[0].properties.shading?.fill, 'DDDDDD');
  assert.deepEqual(cells(0)[0].properties.borders?.top, { val: 'single', color: '000000', sz: 4 });
  assert.deepEqual(cells(0)[0].properties.margins?.left, { w: '55', type: 'dxa' });
  assert.equal(cells(1).length, 1);
  assert.equal(cells(1)[0].properties.gridSpan, 2);
  assert.equal(cells(2)[0].properties.vMerge, 'restart');
  assert.equal(cells(3)[0].properties.vMerge, 'continue');
  assert.equal(paragraphText(cells(3)[1].children[0] as Paragraph), 'r4');
  assert.equal(cells(3)[1].properties.width?.w, '6803');
});

test('pictures become drawings with their bytes; floating frames keep their anchoring', async () => {
  const { document, extension, paragraphs } = await fixture();
  const p = byText(paragraphs, 'In a section');
  const drawing = runs(p).flatMap((r) => r.content).find((c) => c.kind === 'drawing');
  assert.ok(drawing && drawing.kind === 'drawing');
  assert.equal(drawing.width, 720000); // 2cm in EMU
  assert.equal(drawing.height, 360000);
  assert.equal(drawing.name, 'Picture 1');
  assert.equal(drawing.description, 'A dot');
  const bytes = await document.media(drawing.image!);
  assert.equal(bytes[1], 0x50); // PNG
  const frame = extension.imageFrames?.find((f) => f.paragraphId === p.attrs['w14:paraId']);
  assert.ok(frame);
  assert.equal(frame.offset, 12);
  assert.match(frame.frame.xml, /text:anchor-type="char"/);
  assert.match(frame.frame.styles![0], /style:wrap="parallel"/);
});

test('page layout, margins and footer with page fields', async () => {
  const { document } = await fixture();
  const s = document.section;
  assert.deepEqual(s.pageSize, { w: 11906, h: 16838 });
  assert.equal(s.margins?.left, 1134);
  assert.equal(s.margins?.top, 1134);
  assert.equal(s.margins?.footer, 1134);
  assert.equal(s.margins?.bottom, 1134 + 283, 'body ends above the footer and its spacing');
  assert.equal(s.pageNumbering?.fmt, 'decimal');
  assert.equal(s.footers.length, 1);
  const footer = document.headersFooters.get(s.footers[0].part)!;
  const p = footer.children[0] as Paragraph;
  assert.equal(p.properties.justification, 'center');
  const items = runs(p).flatMap((r) => r.content);
  const instr = items.filter((c) => c.kind === 'instrText').map((c) => (c.kind === 'instrText' ? c.text.trim() : ''));
  assert.deepEqual(instr, ['PAGE', 'NUMPAGES']);
  assert.equal(items.filter((c) => c.kind === 'fieldChar').length, 6);
});

test('the extension keeps what the core cannot hold', async () => {
  const { extension, paragraphs } = await fixture();
  const id = (text: string) => byText(paragraphs, text).attrs['w14:paraId'];
  assert.match(extension.meta!, /<dc:title>Fixture<\/dc:title>/);
  assert.match(extension.settings!, /TabsRelativeToIndent/);

  const [annotation] = extension.annotations!;
  assert.equal(annotation.author, 'Ada Lovelace');
  assert.equal(annotation.date, '2024-05-01T10:00:00');
  assert.equal(annotation.initials, 'AL');
  assert.deepEqual(annotation.text, ['A comment', 'Second line']);
  assert.equal(annotation.paragraphId, id('Small sans'));
  assert.equal(annotation.offset, 'Small sans text'.length);
  assert.deepEqual(annotation.end, { paragraphId: id('Small sans'), offset: 'Small sans text with a comment'.length });

  const [bookmark] = extension.bookmarks!;
  assert.equal(bookmark.name, 'Target');
  assert.equal(bookmark.offset, 'Small sans text with a comment range and '.length);
  assert.equal(bookmark.end!.offset, bookmark.offset + 'a bookmark'.length);

  const fields = extension.fields!;
  assert.deepEqual(
    fields.map((f) => [f.text, f.offset]),
    [
      ['01/05/2024', 6],
      ['Ada', 20],
    ],
  );
  assert.match(fields[0].fragment.styles![0], /number:date-style/);

  const [section] = extension.sections!;
  assert.equal(section.name, 'Section1');
  assert.equal(section.firstParagraphId, id('In a section'));
  assert.equal(section.lastParagraphId, id('Footnote'));
  assert.match(section.styles![0], /fo:column-count="2"/);

  const objects = extension.objects!;
  const page = objects.find((o) => o.placement === 'block')!;
  assert.equal(page.paragraphId, null, 'a frame before any paragraph goes at the start');
  assert.match(page.fragment.xml, /PageFrame/);
  const note = objects.find((o) => o.fragment.xml.startsWith('<text:note'))!;
  assert.deepEqual([note.placement, note.paragraphId, note.offset], ['inline', id('Footnote'), 8]);

  assert.equal(extension.prologue!.length, 1);
  assert.ok(extension.styleDefinitions!.some((s) => s.startsWith('<text:outline-style')));
  assert.equal(extension.styles!['Quotations'].attributes!['style:paragraph-properties']['style:auto-text-indent'], 'false');
  assert.equal(extension.paragraphs![id('Indented')].attributes!['style:paragraph-properties']['fo:hyphenation-ladder-count'], '3');
  assert.ok(extension.page!.layout!.children!['style:page-layout-properties'][0].startsWith('<style:footnote-sep'));
  // No LibreOffice revision ids.
  assert.doesNotMatch(JSON.stringify(extension), /rsid/);
  // Plain JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(extension)), extension);
});

test('minimal documents: no styles part, unstyled headings, odd prefixes, list restarts', async () => {
  const content = `<?xml version="1.0"?>
<o:document-content xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:t="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:tb="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
<o:body><o:text>
  <t:h t:outline-level="2">  Plain   heading </t:h>
  <t:p>a<t:span>b<t:span>c</t:span></t:span>
     d</t:p>
  <t:list>
    <t:list-item><t:p>one</t:p></t:list-item>
    <t:list-item t:start-value="7"><t:p>seven</t:p></t:list-item>
  </t:list>
  <tb:table>
    <tb:table-row><tb:table-cell tb:number-columns-repeated="3"><t:p>x</t:p></tb:table-cell></tb:table-row>
  </tb:table>
</o:text></o:body></o:document-content>`;
  const { document } = await readOdt(await odtPackage({ content }));
  const [heading, mixed, one, seven] = paragraphsIn(document.body);
  assert.equal(heading.properties.style, 'Heading2');
  assert.equal(paragraphText(heading), 'Plain heading ');
  assert.equal(paragraphText(mixed), 'abc d');
  assert.notEqual(one.properties.numbering?.id, seven.properties.numbering?.id, 'a start value mid-list restarts');
  const resolver = new StyleResolver(document.styles, document.theme, document.numbering);
  assert.equal(resolver.listLevel(seven.properties.numbering!.id, 0)?.start, 7);
  const table = document.body.find((b): b is Table => b.kind === 'table')!;
  assert.equal(table.grid.length, 3);
  assert.equal((table.rows[0] as TableRow).cells.length, 3);
});

test('xml:ids written by writeOdt become the paragraph ids again', async () => {
  const content = minimalContent('<text:p xml:id="para-0000000A">a</text:p><text:p>b</text:p><text:p xml:id="para-0000000A">dup</text:p><text:p xml:id="other">c</text:p>');
  const { document } = await readOdt(await odtPackage({ content }));
  assert.deepEqual(
    paragraphsIn(document.body).map((p) => p.attrs['w14:paraId']),
    ['0000000A', '00000001', '00000002', '00000003'],
  );
});

test('a flat XML document (.fodt) reads too', async () => {
  const flat = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
<office:meta><meta:generator>x</meta:generator></office:meta>
<office:styles><style:style style:name="Standard" style:family="paragraph"><style:text-properties fo:font-size="14pt"/></style:style></office:styles>
<office:automatic-styles><style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style></office:automatic-styles>
<office:body><office:text><text:p text:style-name="Standard">Hi <text:span text:style-name="T1">there</text:span></text:p></office:text></office:body>
</office:document>`;
  const { document, extension } = await readOdt(new TextEncoder().encode(flat));
  const [p] = paragraphsIn(document.body);
  assert.equal(paragraphText(p), 'Hi there');
  assert.equal(runWith(p, 'there')?.properties.bold, true);
  assert.equal(document.styles.styles.find((s) => s.id === 'Normal')?.runProperties?.size, 28);
  assert.match(extension.meta!, /<meta:generator>x<\/meta:generator>/);
  assert.match(extension.meta!, /xmlns:meta=/);
});
