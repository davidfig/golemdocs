// DocBook, JATS, FictionBook and OPML import/export (src/formats/docbook.ts, jats.ts, fb2.ts, opml.ts
// and what they share in xmlOutline.ts), and how an .xml file is recognised as one of them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { docbook, fb2, jats, opml } from '../src/formats/handlers/xmlDocuments.ts';
import { markdownToDocument } from '../src/formats/markdown.ts';
import { documentToOutline, outlineToDocument } from '../src/formats/outline.ts';
import type { Node } from '../src/formats/outline.ts';
import { sourceFromFile, xmlDocumentKind } from '../src/formats/source.ts';
import { decodeXml } from '../src/formats/xmlOutline.ts';

const fonts = undefined as never;
const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);
const read = async (handler: typeof docbook, text: string | Uint8Array): Promise<Node[]> => documentToOutline((await handler.read(typeof text === 'string' ? bytes(text) : text)).document);
const kinds = (nodes: Node[]) => nodes.map((n) => n.t);

test('DocBook: reads a DocBook 4 book with its DTD, sections, lists, code and tables', async () => {
  const nodes = await read(
    docbook,
    `<?xml version="1.0"?>
<!DOCTYPE book PUBLIC "-//OASIS//DTD DocBook XML V4.5//EN" "docbookx.dtd" [ <!ENTITY product "Golem"> ]>
<book>
  <bookinfo><title>The Book</title></bookinfo>
  <chapter><title>Intro</title>
    <para>Hello <emphasis role="bold">bold</emphasis>, <emphasis>it</emphasis>, <literal>code</literal>&nbsp;and <ulink url="https://x.org">a site</ulink><footnote><para>never</para></footnote>.
      <itemizedlist><listitem><para>inside</para></listitem></itemizedlist>
    after</para>
    <programlisting language="c">int x;
</programlisting>
    <sect1><title>Deep</title>
      <note><para>A note.</para></note>
      <orderedlist startingnumber="3"><listitem><para>three</para></listitem></orderedlist>
      <informaltable><tgroup cols="2"><thead><row><entry>A</entry><entry>B</entry></row></thead>
        <tbody><row><entry>1</entry><entry><para>2</para></entry></row></tbody></tgroup></informaltable>
    </sect1>
  </chapter>
</book>`,
  );
  assert.deepEqual(kinds(nodes), ['heading', 'heading', 'para', 'list', 'para', 'code', 'heading', 'para', 'list', 'table']);
  assert.deepEqual(nodes.filter((n) => n.t === 'heading').map((n) => (n as { level: number }).level), [1, 2, 3]);
  assert.deepEqual((nodes[2] as { spans: unknown }).spans, [
    { text: 'Hello ' },
    { text: 'bold', bold: true },
    { text: ', ' },
    { text: 'it', italic: true },
    { text: ', ' },
    { text: 'code', code: true },
    { text: ' and ' },
    { text: 'a site', link: 'https://x.org' },
    { text: '.' },
  ]);
  assert.deepEqual(nodes[5], { t: 'code', text: 'int x;' });
  assert.equal((nodes[8] as { start: number }).start, 3);
  assert.equal((nodes[9] as { header: boolean }).header, true);
});

test('DocBook and JATS: an article starting with its only heading 1 has it as its title', async () => {
  const outline: Node[] = [
    { t: 'heading', level: 1, spans: [{ text: 'Title' }] },
    { t: 'para', spans: [{ text: 'Intro' }] },
    { t: 'heading', level: 2, spans: [{ text: 'Part' }] },
    { t: 'heading', level: 4, spans: [{ text: 'Skipped a level' }] },
  ];
  const source = await outlineToDocument(outline);
  for (const [handler, title] of [[docbook, '<title>Title</title>'], [jats, '<article-title>Title</article-title>']] as const) {
    const file = str(await handler.write(source, {}, fonts));
    assert.ok(file.includes(title), file);
    assert.deepEqual(await read(handler, file), documentToOutline(source), file);
  }
});

test('JATS: reads the title, abstract, sections, formulas and references, and leaves citations out', async () => {
  const nodes = await read(
    jats,
    `<!DOCTYPE article PUBLIC "-//NLM//DTD JATS (Z39.96) Journal Publishing DTD v1.2 20190208//EN" "JATS-journalpublishing1.dtd">
<article dtd-version="1.2" xmlns:xlink="http://www.w3.org/1999/xlink">
  <front><journal-meta><journal-title-group><journal-title>J</journal-title></journal-title-group></journal-meta>
    <article-meta><title-group><article-title>A <italic>Paper</italic></article-title></title-group>
      <contrib-group><contrib><name><surname>Smith</surname></name></contrib></contrib-group>
      <abstract><p>The abstract.</p></abstract></article-meta></front>
  <body><sec><title>Methods</title>
    <p>As shown <xref ref-type="bibr" rid="b1">[1]</xref>, <inline-formula><tex-math>$E=mc^2$</tex-math></inline-formula> holds<fn><p>see</p></fn>. <ext-link xlink:href="https://x.org">Link</ext-link>.</p>
    <list list-type="bullet"><list-item><p>one</p></list-item></list>
    <disp-quote><p>Quoted.</p></disp-quote>
    <table-wrap><label>Table 1</label><caption><p>Caption.</p></caption><table><thead><tr><th>H</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table></table-wrap>
  </sec></body>
  <back><ref-list><title>References</title><ref id="b1"><label>1</label><mixed-citation>Smith J. A book. 2020.</mixed-citation></ref></ref-list></back>
</article>`,
  );
  assert.deepEqual(kinds(nodes), ['heading', 'para', 'heading', 'para', 'list', 'quote', 'para', 'table', 'heading', 'para']);
  assert.deepEqual((nodes[0] as { spans: unknown }).spans, [{ text: 'A ' }, { text: 'Paper', italic: true }]);
  assert.deepEqual((nodes[3] as { spans: unknown }).spans, [
    { text: 'As shown , ' },
    { text: 'E=mc^2', math: 'inline' },
    { text: ' holds. ' },
    { text: 'Link', link: 'https://x.org' },
    { text: '.' },
  ]);
  assert.deepEqual(nodes[9], { t: 'para', spans: [{ text: '1 Smith J. A book. 2020.' }] });
});

test('FictionBook: reads a windows-1251 book, its title, sections, poems, quotes and scene breaks', async () => {
  const xml = `<?xml version="1.0" encoding="windows-1251"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description><title-info><book-title>Ignored</book-title></title-info></description>
  <body><title><p>Книга</p><p>Подзаголовок</p></title>
    <section><title><p>Глава 1</p></title>
      <p>Текст <strong>жирный</strong><a l:href="#n1" type="note">[1]</a> и <a l:href="https://x.org">ссылка</a>.</p>
      <subtitle>* * *</subtitle>
      <poem><stanza><v>строка один</v><v>строка два</v></stanza></poem>
      <cite><p>Цитата</p><text-author>Автор</text-author></cite>
      <empty-line/>
    </section>
  </body>
  <body name="notes"><section><title><p>1</p></title><p>Примечание</p></section></body>
</FictionBook>`;
  // Encoded as windows-1251, as the declaration says.
  const cp1251 = Uint8Array.from([...xml].map((c) => (c.charCodeAt(0) >= 0x410 && c.charCodeAt(0) <= 0x44f ? c.charCodeAt(0) - 0x410 + 0xc0 : c.charCodeAt(0))));
  assert.equal(decodeXml(cp1251), xml);
  const nodes = await read(fb2, cp1251);
  assert.deepEqual(kinds(nodes), ['heading', 'heading', 'para', 'rule', 'para', 'quote', 'heading', 'para']);
  assert.deepEqual(nodes[0], { t: 'heading', level: 1, spans: [{ text: 'Книга Подзаголовок' }] });
  assert.deepEqual((nodes[2] as { spans: unknown }).spans, [{ text: 'Текст ' }, { text: 'жирный', bold: true }, { text: '[1] и ' }, { text: 'ссылка', link: 'https://x.org' }, { text: '.' }]);
  assert.deepEqual(nodes[4], { t: 'para', spans: [{ text: 'строка один' }, { text: '', br: true }, { text: 'строка два' }] });
  assert.deepEqual(nodes[5], { t: 'quote', paras: [[{ text: 'Цитата' }], [{ text: 'Автор' }]] });
});

test('FictionBook: writes a valid book; lists and code become paragraphs', async () => {
  const source = await markdownToDocument('# Story\n\nOnce.\n\n## One\n\n- a\n- b\n\n1. x\n\n```\ncode()\n```\n');
  source.properties.author = 'A. Writer';
  const file = str(await fb2.write(source, {}, fonts));
  assert.match(file, /<book-title>Story<\/book-title>/);
  assert.match(file, /<nickname>A\. Writer<\/nickname>/);
  assert.match(file, /<body>\s*<title><p>Story<\/p><\/title>/);
  // A section holds either sections or paragraphs: "Once." is in a section without a title.
  assert.match(file, /<section>\s*<p>Once\.<\/p>\s*<\/section>/);
  const nodes = await read(fb2, file);
  assert.deepEqual(kinds(nodes), ['heading', 'para', 'heading', 'para', 'para', 'para', 'para']);
  assert.deepEqual(
    nodes.slice(3).map((n) => (n as { spans: { text: string }[] }).spans.map((s) => s.text).join('')),
    ['• a', '• b', '1. x', 'code()'],
  );
  // The same document gives the same file (its id is a hash of the text).
  assert.equal(str(await fb2.write(source, {}, fonts)), file);
});

test('OPML: opens as its title over a nested list, with notes and links', async () => {
  const nodes = await read(
    opml,
    `<?xml version="1.0"?><opml version="2.0"><head><title>Plan</title></head><body>
      <outline text="First &lt;b&gt;step&lt;/b&gt;" _note="A note.&#10;&#10;Second paragraph."><outline text="Sub"/></outline>
      <outline text="Feed" type="rss" xmlUrl="https://f.example/rss"/>
    </body></opml>`,
  );
  assert.deepEqual(nodes, [
    { t: 'heading', level: 1, spans: [{ text: 'Plan' }] },
    {
      t: 'list',
      ordered: false,
      start: 1,
      items: [
        {
          spans: [{ text: 'First step' }],
          children: [
            { t: 'para', spans: [{ text: 'A note.' }] },
            { t: 'para', spans: [{ text: 'Second paragraph.' }] },
            { t: 'list', ordered: false, start: 1, items: [{ spans: [{ text: 'Sub' }], children: [] }] },
          ],
        },
        { spans: [{ text: 'Feed', link: 'https://f.example/rss' }], children: [] },
      ],
    },
  ]);
});

test('OPML: headings are the tree, and a list read back is the same list', async () => {
  const source = await markdownToDocument('# Plan\n\n## Phase\n\nDo [this](https://x.org).\n\n- a\n\n  note\n\n  - a1\n- b\n');
  const file = str(await opml.write(source, {}, fonts));
  assert.match(file, /<title>Plan<\/title>/);
  assert.match(file, /<outline text="Phase">\s*<outline text="Do this\."\/>/);
  assert.match(file, /<outline text="a" _note="note">\s*<outline text="a1"\/>/);
  const list: Node = { t: 'list', ordered: false, start: 1, items: [{ spans: [{ text: 'a' }], children: [{ t: 'para', spans: [{ text: 'note' }] }, { t: 'list', ordered: false, start: 1, items: [{ spans: [{ text: 'b' }], children: [] }] }] }] };
  const back = await read(opml, await opml.write(await outlineToDocument([list]), {}, fonts));
  assert.deepEqual(back, [list]);
});

test('XML formats: text that is not XML is an error that names the format', async () => {
  for (const [handler, name] of [[docbook, 'DocBook'], [jats, 'JATS'], [fb2, 'FictionBook'], [opml, 'OPML']] as const) {
    await assert.rejects(() => handler.read(bytes('just text')), new RegExp(`not a ${name} file`));
    await assert.rejects(() => handler.read(bytes('<a><b></a>')), Error);
  }
});

test('an .xml file opens as the document format its root element says, and other XML as text', () => {
  const kind = (text: string) => xmlDocumentKind(bytes(text).buffer as ArrayBuffer);
  assert.equal(kind('<?xml version="1.0"?>\n<!-- x -->\n<article xmlns="http://docbook.org/ns/docbook" version="5.0"/>'), 'docbook');
  assert.equal(kind('<!DOCTYPE book PUBLIC "-//OASIS//DTD DocBook XML V4.5//EN" "x.dtd"><book/>'), 'docbook');
  assert.equal(kind('<?xml version="1.0"?><article article-type="research-article" dtd-version="1.3"/>'), 'jats');
  assert.equal(kind('<!DOCTYPE article PUBLIC "-//NLM//DTD JATS (Z39.96) Journal Publishing DTD v1.2//EN" "x.dtd"><article/>'), 'jats');
  assert.equal(kind('<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"/>'), 'fb2');
  assert.equal(kind('<opml version="2.0"/>'), 'opml');
  assert.equal(kind('<project><modelVersion>4.0.0</modelVersion></project>'), null);
  assert.equal(kind('<article xmlns="http://www.w3.org/1999/xhtml"/>'), null);
  assert.equal(sourceFromFile('pom.xml', bytes('<project/>').buffer as ArrayBuffer)?.kind, 'txt');
  assert.equal(sourceFromFile('paper.xml', bytes('<article dtd-version="1.3"/>').buffer as ArrayBuffer)?.kind, 'jats');
  assert.equal(sourceFromFile('book.fb2', bytes('<FictionBook/>').buffer as ArrayBuffer)?.kind, 'fb2');
});
