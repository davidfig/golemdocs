// HTML import/export (src/formats/html.ts).
// Run: node --experimental-transform-types --test test/html.test.ts
// (the flag is only needed because @word/docx uses TypeScript parameter properties.)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StyleResolver, WordDocument, paragraphText, paragraphsIn } from '@word/docx';
import type { Hyperlink, Inline, Paragraph, Run, Table, TableCell, TableRow } from '@word/docx';
import { documentToHtml, htmlToDocument } from '../src/formats/html.ts';
import { markdownToDocument } from '../src/formats/markdown.ts';

// --- Helpers --------------------------------------------------------------------------------------

const paragraphs = (doc: WordDocument): Paragraph[] => doc.body.filter((b): b is Paragraph => b.kind === 'paragraph');
const tables = (doc: WordDocument): Table[] => doc.body.filter((b): b is Table => b.kind === 'table');
const styles = (doc: WordDocument): (string | undefined)[] => paragraphs(doc).map((p) => p.properties.style);
const texts = (doc: WordDocument): string[] => paragraphs(doc).map((p) => paragraphText(p));

/** Flat runs of a paragraph, with hyperlink runs included. */
function runs(inlines: readonly Inline[]): Run[] {
  const out: Run[] = [];
  for (const i of inlines) {
    if (i.kind === 'run') out.push(i);
    else if (i.kind === 'hyperlink' || i.kind === 'wrapper') out.push(...runs(i.children));
  }
  return out;
}
const runText = (r: Run): string => r.content.map((c) => (c.kind === 'text' ? c.text : c.kind === 'tab' ? '\t' : c.kind === 'break' ? '\n' : '')).join('');
const runOf = (p: Paragraph, text: string): Run => {
  const found = runs(p.children).find((r) => runText(r) === text);
  assert.ok(found, `no run "${text}" in ${JSON.stringify(runs(p.children).map(runText))}`);
  return found;
};
const cells = (row: TableRow | undefined): TableCell[] => (row?.cells ?? []).filter((c): c is TableCell => c.kind === 'cell');
const cellText = (cell: TableCell): string => paragraphsIn(cell.children).map(paragraphText).join('|');

const load = (html: string) => htmlToDocument(html);
const roundTrip = async (html: string): Promise<string> => {
  const { document, extension } = await htmlToDocument(html);
  return documentToHtml(document, extension);
};

/** Export is a fixed point after one normalisation: html -> doc -> html -> doc -> html is stable. */
async function assertStable(html: string): Promise<string> {
  const once = await roundTrip(html);
  const twice = await roundTrip(once);
  assert.equal(twice, once, `unstable round trip for ${JSON.stringify(html)}`);
  return once;
}

/** The part of an exported page between <body ...> and </body>. */
const bodyOf = (html: string): string => /<body[^>]*>\n([\s\S]*?)<\/body>/.exec(html)?.[1] ?? '';

const run = (text: string, properties: Run['properties'] = {}): Run => ({ kind: 'run', properties, content: [{ kind: 'text', text }], attrs: {} });
const para = (children: Paragraph['children'], properties: Paragraph['properties'] = {}): Paragraph => ({ kind: 'paragraph', properties, children, attrs: {} });

// --- Structure ------------------------------------------------------------------------------------

test('headings, paragraphs and containers map to paragraph styles', async () => {
  const { document } = await load('<h1>One</h1><h2>Two</h2><h6>Six</h6><p>Para</p><div>Div text</div><section><p>In section</p></section>');
  assert.deepEqual(styles(document), ['Heading1', 'Heading2', 'Heading6', undefined, undefined, undefined]);
  assert.deepEqual(texts(document), ['One', 'Two', 'Six', 'Para', 'Div text', 'In section']);
  const ids = new Set(document.styles.styles.map((s) => s.id));
  for (const id of ['Heading1', 'Heading2', 'Heading6']) assert.ok(ids.has(id), id);
  const resolver = new StyleResolver(document.styles, document.theme, document.numbering);
  assert.equal(resolver.paragraph({ style: 'Heading6' }).outlineLevel, 5);
});

test('every paragraph gets a unique sequential w14:paraId', async () => {
  const { document } = await load('<p>a</p><ul><li>b</li></ul><table><tr><td>c</td><td></td></tr></table><pre>d\ne</pre>');
  const ids = paragraphsIn(document.body).map((p) => p.attrs['w14:paraId']);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id ?? '', /^[0-9A-F]{8}$/);
    assert.ok(parseInt(id!, 16) > 0 && parseInt(id!, 16) < 0x80000000);
  }
  assert.equal(ids[0], '00000001');
});

test('unclosed <p>, <li>, <td> and <tr> close the way browsers close them', async () => {
  const { document } = await load('<p>one<p>two<ul><li>a<li>b</ul><table><tr><td>1<td>2<tr><td>3<td>4</table>');
  assert.deepEqual(texts(document), ['one', 'two', 'a', 'b']);
  const [table] = tables(document);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(
    table.rows.map((r) => cells(r as TableRow).map(cellText)),
    [
      ['1', '2'],
      ['3', '4'],
    ],
  );
});

test('blockquotes use the Quote style, nesting adds indent', async () => {
  const { document } = await load('<blockquote><p>outer</p><blockquote>inner</blockquote></blockquote><p>after</p>');
  assert.deepEqual(styles(document), ['Quote', 'Quote', undefined]);
  assert.equal(paragraphs(document)[0].properties.indent, undefined);
  assert.equal(paragraphs(document)[1].properties.indent?.left, 720);
  const html = await assertStable('<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>');
  assert.match(bodyOf(html), /<blockquote>\n {2}<p>outer<\/p>\n {2}<blockquote>\n {4}<p>inner<\/p>\n {2}<\/blockquote>\n<\/blockquote>/);
});

test('<pre> keeps whitespace, one Code paragraph per line', async () => {
  const { document, extension } = await load('<pre>\n  first\n\tsecond  x\n\nlast\n</pre><p>a   b\n  c</p>');
  assert.deepEqual(styles(document), ['Code', 'Code', 'Code', 'Code', undefined]);
  const lines = paragraphs(document).slice(0, 4).map((p) => runs(p.children).map(runText).join(''));
  assert.deepEqual(lines, ['  first', '\tsecond  x', '', 'last']);
  assert.equal(texts(document)[4], 'a b c');
  const html = documentToHtml(document, extension);
  assert.match(html, /<pre> {2}first\n\tsecond {2}x\n\nlast<\/pre>/);
  await assertStable('<pre><code class="language-js">let a = 1;\n  if (a) {\n\treturn;\n}\n</code></pre>');
});

test('whitespace collapses like a browser: leading, trailing, runs and around breaks', async () => {
  const { document } = await load('<p>\n   Hello   <b> big </b>  world  <br>  next \n</p>');
  const p = paragraphs(document)[0];
  assert.deepEqual(
    runs(p.children).map(runText),
    ['Hello ', 'big ', 'world\nnext'],
  );
  // Doubled spaces and edge spaces in the model survive export as &nbsp;.
  const doc = await WordDocument.create();
  doc.body = [para([run(' two  spaces ')])];
  const html = documentToHtml(doc);
  assert.match(bodyOf(html), /<p>&nbsp;two &nbsp;spaces&nbsp;<\/p>/);
  const again = await load(html);
  assert.equal(texts(again.document)[0], ' two  spaces ');
});

test('entities: named, numeric, legacy without semicolon, in attributes', async () => {
  const { document } = await load(
    '<p>&amp; &lt;b&gt; &copy; &eacute;&euro;&hellip; &#169; &#x1F600; &#150; &unknown; &amp &copy2024 AT&T</p><p><a href="?a=1&amp;b=2&copy=3">x</a></p>',
  );
  assert.equal(texts(document)[0], '& <b> © é€… © 😀 – &unknown; & ©2024 AT&T');
  const link = paragraphs(document)[1].children[0] as Hyperlink;
  assert.equal(link.url, '?a=1&b=2&copy=3');
});

test('comments, doctype, <script> and <style> raw text never become document text', async () => {
  const { document, extension } = await load(
    '<!DOCTYPE html><!-- top --><p>a<!-- inline --></p><script>if (a < b) document.write("<p>x</p>")</script><style>p { color: red }</style><p>b</p>',
  );
  assert.deepEqual(texts(document), ['a', 'b']);
  const raws = (extension.fragments ?? []).map((f) => f.html);
  assert.ok(raws.includes('<!-- inline -->'));
  assert.ok(raws.some((h) => h.startsWith('<script>if (a < b)')));
  assert.ok(raws.some((h) => h.startsWith('<style>')));
  assert.ok(extension.head?.includes('<!-- top -->'));
});

test('horizontal rules are empty paragraphs with a bottom border', async () => {
  const { document } = await load('<p>a</p><hr><p>b</p>');
  const rule = paragraphs(document)[1];
  assert.equal(rule.children.length, 0);
  assert.equal(rule.properties.borders?.bottom?.val, 'single');
  assert.match(bodyOf(await assertStable('<p>a</p><hr><p>b</p>')), /<p>a<\/p>\n<hr>\n<p>b<\/p>/);
});

test('empty elements without attributes are dropped, a lone <br> is a blank line', async () => {
  const { document } = await load('<p>a</p><p></p><div>  </div><p><br></p><p>b<br></p><p>c<br><br></p>');
  assert.deepEqual(texts(document), ['a', '', 'b', 'c￼']);
  const html = await assertStable('<p>a</p><p><br></p><p>c<br><br></p>');
  assert.match(bodyOf(html), /<p>a<\/p>\n<p><br><\/p>\n<p>c<br><br><\/p>/);
});

// --- Inline formatting ----------------------------------------------------------------------------

test('inline tags become run properties', async () => {
  const { document } = await load(
    '<p><b>b</b> <strong>st</strong> <i>i</i> <em>em</em> <u>u</u> <s>s</s> <del>del</del> <sup>sup</sup> <sub>sub</sub> <code>code</code> <kbd>kbd</kbd> <mark>mark</mark> <b><i>both</i></b></p>',
  );
  const p = paragraphs(document)[0];
  assert.equal(runOf(p, 'b').properties.bold, true);
  assert.equal(runOf(p, 'st').properties.bold, true);
  assert.equal(runOf(p, 'i').properties.italic, true);
  assert.equal(runOf(p, 'em').properties.italic, true);
  assert.equal(runOf(p, 'u').properties.underline?.val, 'single');
  assert.equal(runOf(p, 's').properties.strike, true);
  assert.equal(runOf(p, 'del').properties.strike, true);
  assert.equal(runOf(p, 'sup').properties.vertAlign, 'superscript');
  assert.equal(runOf(p, 'sub').properties.vertAlign, 'subscript');
  assert.equal(runOf(p, 'code').properties.style, 'InlineCode');
  assert.equal(runOf(p, 'code').properties.fonts?.ascii, 'Courier New');
  assert.equal(runOf(p, 'kbd').properties.style, 'InlineCode');
  assert.equal(runOf(p, 'mark').properties.highlight, 'yellow');
  assert.deepEqual([runOf(p, 'both').properties.bold, runOf(p, 'both').properties.italic], [true, true]);
  const html = await assertStable('<p><strong>b</strong> <em>i</em> <u>u</u> <s>s</s> x<sup>2</sup> H<sub>2</sub>O <code>c</code> <mark>m</mark></p>');
  assert.match(bodyOf(html), /<p><strong>b<\/strong> <em>i<\/em> <u>u<\/u> <s>s<\/s> x<sup>2<\/sup> H<sub>2<\/sub>O <code>c<\/code> <mark>m<\/mark><\/p>/);
});

test('inline CSS and <font> map to colours, fonts and sizes', async () => {
  const { document } = await load(
    '<p><span style="color: #f00; background-color: rgb(0, 255, 0); font-family: \'Times New Roman\', serif; font-size: 16px; font-weight: 700; font-style: italic; text-decoration: underline line-through">styled</span>' +
      '<font color="navy" face="Arial" size="5">font</font><span style="font-size: 2em"><span style="font-size: 50%">rel</span></span>' +
      '<span style="text-transform: uppercase; font-variant: small-caps; vertical-align: super">caps</span></p>',
  );
  const p = paragraphs(document)[0];
  const styled = runOf(p, 'styled').properties;
  assert.equal(styled.color?.val, 'FF0000');
  assert.equal(styled.shading?.fill, '00FF00');
  assert.equal(styled.fonts?.ascii, 'Times New Roman');
  assert.equal(styled.size, 24);
  assert.equal(styled.bold, true);
  assert.equal(styled.italic, true);
  assert.equal(styled.underline?.val, 'single');
  assert.equal(styled.strike, true);
  const font = runOf(p, 'font').properties;
  assert.deepEqual([font.color?.val, font.fonts?.ascii, font.size], ['000080', 'Arial', 36]);
  assert.equal(runOf(p, 'rel').properties.size, 24);
  const caps = runOf(p, 'caps').properties;
  assert.deepEqual([caps.caps, caps.smallCaps, caps.vertAlign], [true, true, 'superscript']);
});

test('block CSS and align= map to paragraph properties; the rest of the style is kept', async () => {
  const { document, extension } = await load(
    '<p style="text-align: center; margin: 6pt 0 12pt 36pt; text-indent: -18pt; line-height: 1.5; border: 1px solid red">a</p><div align="right">b</div><p style="page-break-before: always; line-height: 20pt">c</p>' +
      '<div style="text-align: justify; color: blue"><p>d</p></div>',
  );
  const [a, b, c, d] = paragraphs(document);
  assert.equal(a.properties.justification, 'center');
  assert.deepEqual(a.properties.spacing, { before: 120, after: 240, line: 360, lineRule: 'auto' });
  assert.deepEqual(a.properties.indent, { left: 720, right: 0, hanging: 360 });
  assert.equal(b.properties.justification, 'right');
  assert.equal(c.properties.pageBreakBefore, true);
  assert.deepEqual(c.properties.spacing, { line: 400, lineRule: 'exact' });
  assert.equal(d.properties.justification, 'both');
  assert.equal(runs(d.children)[0].properties.color?.val, '0000FF');
  assert.deepEqual(extension.blocks?.[a.attrs['w14:paraId']!]?.attrs, { style: 'border: 1px solid red' });
  const html = await assertStable('<p style="text-align: center; margin: 6pt 0 12pt 36pt; text-indent: -18pt; line-height: 1.5; border: 1px solid red">a</p>');
  assert.ok(bodyOf(html).includes('border: 1px solid red'));
  assert.ok(bodyOf(html).includes('text-align: center'));
});

test('links and images', async () => {
  const { document } = await load('<p>See <a href="https://example.com" title="t">the <b>site</b></a>, <a href="#top">top</a> and <img src="pic.png" alt="A  cat"><img src="x.gif"></p>');
  const p = paragraphs(document)[0];
  const links = p.children.filter((c): c is Hyperlink => c.kind === 'hyperlink');
  assert.equal(links.length, 4);
  assert.equal(links[0].url, 'https://example.com');
  assert.deepEqual(runs(links[0].children).map((r) => [runText(r), r.properties.style, r.properties.bold]), [
    ['the ', 'Hyperlink', undefined],
    ['site', 'Hyperlink', true],
  ]);
  assert.equal(links[1].anchor, 'top');
  assert.equal(links[2].url, 'pic.png');
  assert.equal(runText(runs(links[2].children)[0]), '[Image: A cat]');
  assert.equal(runs(links[2].children)[0].properties.style, 'ImagePlaceholder');
  assert.equal(runText(runs(links[3].children)[0]), '[Image]');
  const html = await assertStable('<p>See <a href="https://example.com">the <strong>site</strong></a>, <a href="#top">top</a> <img src="pic.png" alt="A cat"></p>');
  assert.match(bodyOf(html), /<p>See <a href="https:\/\/example\.com">the <strong>site<\/strong><\/a>, <a href="#top">top<\/a> <img src="pic\.png" alt="A cat"><\/p>/);
});

// --- Lists ----------------------------------------------------------------------------------------

test('nested lists get real numbering; ol start and type are kept', async () => {
  const { document } = await load('<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul><ol start="4" type="a"><li>d</li><li>e</li></ol>');
  const ps = paragraphs(document);
  assert.deepEqual(texts(document), ['a', 'a1', 'a2', 'b', 'd', 'e']);
  assert.deepEqual(
    ps.map((p) => [p.properties.style, p.properties.numbering?.level]),
    [
      ['ListParagraph', 0],
      ['ListParagraph', 1],
      ['ListParagraph', 1],
      ['ListParagraph', 0],
      ['ListParagraph', 0],
      ['ListParagraph', 0],
    ],
  );
  const resolver = new StyleResolver(document.styles, document.theme, document.numbering);
  assert.equal(resolver.listLevel(ps[0].properties.numbering?.id, 0)?.format, 'bullet');
  const ordered = resolver.listLevel(ps[4].properties.numbering?.id, 0);
  assert.deepEqual([ordered?.format, ordered?.start], ['lowerLetter', 4]);
  assert.notEqual(ps[0].properties.numbering?.id, ps[1].properties.numbering?.id);
  const html = await assertStable('<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul><ol start="4" type="a"><li>d</li><li>e</li></ol>');
  assert.equal(
    bodyOf(html),
    '<ul>\n  <li>a\n    <ul>\n      <li>a1</li>\n      <li>a2</li>\n    </ul>\n  </li>\n  <li>b</li>\n</ul>\n<ol type="a" start="4">\n  <li>d</li>\n  <li>e</li>\n</ol>\n',
  );
});

test('list items with several paragraphs and items that start with a nested list', async () => {
  const { document } = await load('<ol><li><p>first</p><p>more</p></li><li><ul><li>inner</li></ul></li><li></li></ol>');
  const ps = paragraphs(document);
  assert.deepEqual(texts(document), ['first', 'more', '', 'inner', '']);
  assert.equal(ps[0].properties.numbering?.level, 0);
  assert.equal(ps[1].properties.numbering, undefined);
  assert.equal(ps[1].properties.style, 'ListParagraph');
  assert.equal(ps[1].properties.indent?.left, 720);
  assert.equal(ps[2].properties.numbering?.level, 0);
  assert.equal(ps[3].properties.numbering?.level, 1);
  const html = await assertStable('<ol><li><p>first</p><p>more</p></li><li><ul><li>inner</li></ul></li><li></li></ol>');
  assert.ok(bodyOf(html).includes('<li><p>first</p>\n    <p>more</p>\n  </li>'));
});

test('a Word list that continues after an interruption keeps its numbers', async () => {
  const md = await markdownToDocument('1. one\n2. two\n');
  const [one, two] = paragraphs(md);
  md.body = [one, para([run('between')]), two];
  const html = documentToHtml(md);
  assert.match(bodyOf(html), /<ol>\n {2}<li>one<\/li>\n<\/ol>\n<p>between<\/p>\n<ol start="2">\n {2}<li>two<\/li>\n<\/ol>/);
});

// --- Tables ---------------------------------------------------------------------------------------

test('tables: header rows, cells, colspan and rowspan', async () => {
  const { document } = await load(
    '<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody><tr><td rowspan="2">r</td><td colspan="2">wide</td></tr><tr><td>x</td><td style="text-align:right; background-color: #ffff00">y</td></tr></tbody></table>',
  );
  const [table] = tables(document);
  assert.equal(table.properties.style, 'TableGrid');
  assert.equal(table.grid.length, 3);
  const rows = table.rows as TableRow[];
  assert.equal(rows[0].properties.header, true);
  assert.equal(rows[1].properties.header, undefined);
  assert.deepEqual(cells(rows[0]).map(cellText), ['A', 'B', 'C']);
  const [r, wide] = cells(rows[1]);
  assert.equal(r.properties.vMerge, 'restart');
  assert.equal(wide.properties.gridSpan, 2);
  const [merged, x, y] = cells(rows[2]);
  assert.equal(merged.properties.vMerge, 'continue');
  assert.equal(cellText(x), 'x');
  assert.equal(y.properties.shading?.fill, 'FFFF00');
  assert.equal((y.children[0] as Paragraph).properties.justification, 'right');
  const html = await assertStable(
    '<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody><tr><td rowspan="2">r</td><td colspan="2">wide</td></tr><tr><td>x</td><td style="text-align:right">y</td></tr></tbody></table>',
  );
  const body = bodyOf(html);
  assert.ok(body.includes('<td rowspan="2">r</td>'));
  assert.ok(body.includes('<td colspan="2">wide</td>'));
  assert.ok(body.includes('<td style="text-align: right">y</td>'));
  assert.ok(body.includes('<thead>'));
});

test('a first row of <th> is a header row; cells can hold blocks and nested tables', async () => {
  const { document } = await load('<table><tr><th>h</th></tr><tr><td><p>one</p><ul><li>two</li></ul><table><tr><td>in</td></tr></table></td></tr></table>');
  const rows = tables(document)[0].rows as TableRow[];
  assert.equal(rows[0].properties.header, true);
  const cell = cells(rows[1])[0];
  assert.deepEqual(
    cell.children.map((b) => b.kind),
    ['paragraph', 'paragraph', 'table'],
  );
  await assertStable('<table><tr><th>h</th></tr><tr><td><p>one</p><ul><li>two</li></ul><table><tr><td>in</td></tr></table></td></tr></table>');
});

// --- Extension ------------------------------------------------------------------------------------

test('the extension restores head, html/body attributes, tags, attributes and wrappers', async () => {
  const src = [
    '<!DOCTYPE html>',
    '<html lang="fr" data-theme="dark">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Page</title>',
    '<link rel="stylesheet" href="site.css">',
    '<style>.note { color: green }</style>',
    '<script src="app.js"></script>',
    '</head>',
    '<body class="home" data-x="1">',
    '<main id="content">',
    '<section class="intro" data-section="1">',
    '<h1 id="title" class="big">Hello</h1>',
    '<div class="note">A note</div>',
    '<p class="lead" data-a="b">Lead</p>',
    '</section>',
    '<ul class="nav"><li class="item"><a href="/">Home</a></li></ul>',
    '<blockquote cite="http://q"><p>Quoted</p></blockquote>',
    '<pre class="sh"><code class="language-sh">ls -la</code></pre>',
    '<table class="grid"><tr class="r"><td class="c">1</td></tr></table>',
    '<dl><dt>Term</dt><dd>Definition</dd></dl>',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
  const { document, extension } = await load(src);
  assert.deepEqual(extension.htmlAttrs, { lang: 'fr', 'data-theme': 'dark' });
  assert.deepEqual(extension.bodyAttrs, { class: 'home', 'data-x': '1' });
  assert.equal(
    extension.head,
    '<meta charset="utf-8">\n<title>Page</title>\n<link rel="stylesheet" href="site.css">\n<style>.note { color: green }</style>\n<script src="app.js"></script>',
  );
  assert.deepEqual(
    extension.wrappers?.map((w) => [w.tag, w.attrs]),
    [
      ['main', { id: 'content' }],
      ['section', { class: 'intro', 'data-section': '1' }],
      ['dl', {}],
    ],
  );
  assert.equal(extension.doctype, undefined);
  // The JSON survives serialisation.
  const ext = JSON.parse(JSON.stringify(extension));
  const html = documentToHtml(document, ext);
  for (const piece of [
    '<html lang="fr" data-theme="dark">',
    '<link rel="stylesheet" href="site.css">',
    '<script src="app.js"></script>',
    '<body class="home" data-x="1">',
    '<main id="content">',
    '<section class="intro" data-section="1">',
    '<h1 id="title" class="big">Hello</h1>',
    '<div class="note">A note</div>',
    '<p class="lead" data-a="b">Lead</p>',
    '<ul class="nav">',
    '<li class="item"><a href="/">Home</a></li>',
    '<blockquote cite="http://q">',
    '<pre class="sh"><code class="language-sh">ls -la</code></pre>',
    '<table class="grid">',
    '<tr class="r">',
    '<td class="c">1</td>',
    '<dt>Term</dt>',
    '<dd>Definition</dd>',
  ]) {
    assert.ok(html.includes(piece), `missing ${piece} in\n${html}`);
  }
  assert.ok(!html.includes('data-word-styles'), 'no generated style block for a hand-written page');
  assert.equal(await roundTrip(html), html);
});

test('unmappable elements are kept verbatim at their anchors, not shown', async () => {
  const src =
    '<p>Before</p><form action="/s"><input name="q"><button>Go</button></form><p>Text <svg width="10"><circle r="4"/></svg> more</p>' +
    '<iframe src="https://v"></iframe><my-widget data-x="1">custom <b>text</b></my-widget><p>End</p><script>track()</script>';
  const { document, extension } = await load(src);
  assert.deepEqual(texts(document), ['Before', 'Text more', 'End']);
  const html = documentToHtml(document, extension);
  const body = bodyOf(html);
  assert.ok(body.includes('<form action="/s"><input name="q"><button>Go</button></form>\n<p>Text more<svg width="10"><circle r="4"/></svg></p>'), body);
  assert.ok(body.includes('<iframe src="https://v"></iframe>\n<my-widget data-x="1">custom <b>text</b></my-widget>\n<p>End</p>\n<script>track()</script>'), body);
  assert.equal(await roundTrip(html), html);
});

test('extension entries for paragraphs that no longer exist are skipped', async () => {
  const { document, extension } = await load('<section class="s"><p id="a">A</p><p>B</p></section><p class="c">C</p><script>x()</script>');
  document.body = document.body.filter((b) => b.kind !== 'paragraph' || paragraphText(b) !== 'C');
  const body = bodyOf(documentToHtml(document, extension));
  assert.equal(body, '<section class="s">\n  <p id="a">A</p>\n  <p>B</p>\n</section>\n');
  // Splitting keeps the id with the first half; a new paragraph gets default markup.
  const { document: d2, extension: e2 } = await load('<p class="x">one</p>');
  d2.body.push(para([run('two')], {}));
  assert.equal(bodyOf(documentToHtml(d2, e2)), '<p class="x">one</p>\n<p>two</p>\n');
});

test('a doctype other than HTML5 and an empty body round-trip', async () => {
  const src = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "x.dtd"><html><head><title>T</title></head><body></body></html>';
  const { document, extension } = await load(src);
  assert.equal(extension.doctype, '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "x.dtd">');
  assert.equal(document.body.length, 1);
  const html = documentToHtml(document, extension);
  assert.ok(html.startsWith('<!DOCTYPE html PUBLIC'));
  assert.equal(bodyOf(html), '<p></p>\n');
  assert.equal(await roundTrip(html), html);
});

// --- Round trips ----------------------------------------------------------------------------------

test('round trip of a typical hand-written page is stable after the first pass', async () => {
  const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Notes</title></head>
<body>
  <header><h1>Project <em>notes</em></h1><nav><a href="/">Home</a> | <a href="/about">About</a></nav></header>
  <article>
    <h2>Summary</h2>
    <p>This is a <strong>short</strong> page with a <a href="https://example.com/x?a=1&amp;b=2">link</a>,
       some <code>code</code>, and an image: <img src="a.png" alt="diagram"></p>
    <ol>
      <li>First step
      <li>Second step
        <ul><li>detail one<li>detail two</ul>
      <li>Third step
    </ol>
    <blockquote><p>A quotation that spans
    two lines.</p></blockquote>
    <pre>
def hello():
    print("hi")
</pre>
    <table>
      <caption>Results</caption>
      <tr><th>Name<th>Score
      <tr><td>Ann<td>10
      <tr><td>Bob<td>7
    </table>
    <p style="color: #336699; text-align: right">Signed, <i>me</i></p>
  </article>
  <footer><p>&copy; 2026</p></footer>
  <script>console.log("done")</script>
</body>
</html>`;
  const once = await assertStable(page);
  const { document } = await load(page);
  assert.deepEqual(styles(document).slice(0, 3), ['Heading1', undefined, 'Heading2']);
  assert.equal(tables(document)[0].properties.caption, 'Results');
  assert.ok(once.includes('<caption>Results</caption>'));
  assert.ok(once.includes('<script>console.log("done")</script>\n</body>'));
});

test('HTML the app wrote round-trips exactly', async () => {
  const md = await markdownToDocument(
    '# Title\n\nSome *em*, **strong**, `code` and a [link](http://x.org).\n\n1. one\n2. two\n   - nested\n\n> quoted\n\n```\ncode block\n  indented\n```\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n![alt text](img.png)\n\n---\n',
  );
  const html = documentToHtml(md);
  assert.equal(await roundTrip(html), html);
  const { document } = await load(html);
  assert.deepEqual(styles(document), ['Heading1', undefined, 'ListParagraph', 'ListParagraph', 'ListParagraph', 'Quote', 'Code', 'Code', undefined, undefined]);
});

test('a Word-style document exports its styles, colours and fonts, and comes back the same', async () => {
  const doc = await WordDocument.create();
  doc.styles.styles.push({
    type: 'paragraph',
    id: 'Callout',
    name: 'Callout',
    basedOn: 'Normal',
    paragraphProperties: { indent: { left: 360 }, justification: 'center' },
    runProperties: { color: { val: 'C00000' }, bold: true },
    attrs: {},
  });
  doc.body = [
    para([run('The Title')], { style: 'Title' }),
    para([run('Intro')], { style: 'Heading1' }),
    para(
      [
        run('Plain '),
        run('Georgia red', { fonts: { ascii: 'Georgia', hAnsi: 'Georgia' }, color: { val: 'FF0000' }, size: 28 }),
        run(' on '),
        run('yellow', { highlight: 'yellow' }),
        run(' and '),
        run('shaded', { shading: { val: 'clear', color: 'auto', fill: 'DDEEFF' } }),
        run(' '),
        run('bold', { bold: true, underline: { val: 'single' } }),
      ],
      { justification: 'both', spacing: { after: 0 } },
    ),
    para([run('Look out')], { style: 'Callout' }),
    para([]),
    para([{ kind: 'run', properties: {}, content: [{ kind: 'text', text: 'tab' }, { kind: 'tab' }, { kind: 'text', text: 'here' }], attrs: {} }]),
  ];
  const html = documentToHtml(doc);
  assert.ok(html.startsWith('<!DOCTYPE html>\n<html lang="en-US">\n<head>\n<meta charset="utf-8">'));
  assert.ok(html.includes('<title>The Title</title>'));
  assert.ok(html.includes('<style data-word-styles>'));
  assert.match(html, /body \{ font-family: Calibri, sans-serif; font-size: 11pt; \}/);
  assert.match(html, /h1 \{ font-family: "Calibri Light", sans-serif; font-size: 16pt; color: #2F5496; font-weight: normal;/);
  assert.match(html, /\.Callout \{[^}]*color: #C00000; font-weight: bold;[^}]*margin: 0 0 8pt 18pt;[^}]*text-align: center; \}/);
  assert.match(html, /\.Title \{[^}]*font-size: 28pt;/);
  const body = bodyOf(html);
  assert.equal(
    body,
    [
      '<h1 class="Title">The Title</h1>',
      '<h1>Intro</h1>',
      '<p style="text-align: justify; margin-bottom: 0">Plain <span style="font-family: Georgia, serif; font-size: 14pt; color: #FF0000">Georgia red</span> on <mark>yellow</mark> and <span style="background-color: #DDEEFF">shaded</span> <strong><u>bold</u></strong></p>',
      '<p class="Callout">Look out</p>',
      '<p><br></p>',
      '<p>tab<span style="white-space: pre">\t</span>here</p>',
      '',
    ].join('\n'),
  );

  // Import reads the style block back into styles, so the page comes back identical.
  const { document, extension } = await load(html);
  assert.equal(extension.wordStyles, true);
  assert.deepEqual(styles(document), ['Title', 'Heading1', undefined, 'Callout', undefined, undefined]);
  const resolver = new StyleResolver(document.styles, document.theme, document.numbering);
  const callout = resolver.run('Callout', {});
  assert.deepEqual([callout.color?.val, callout.bold], ['C00000', true]);
  assert.equal(resolver.paragraph({ style: 'Callout' }).justification, 'center');
  const georgia = runOf(paragraphs(document)[2], 'Georgia red').properties;
  assert.deepEqual([georgia.fonts?.ascii, georgia.color?.val, georgia.size], ['Georgia', 'FF0000', 28]);
  assert.equal(documentToHtml(document, extension), html);
});

// --- Robustness -----------------------------------------------------------------------------------

test('garbage and truncated input never throws', async () => {
  const inputs = [
    '',
    '<',
    '<<<>>>',
    '</p></div></table>',
    '<p',
    '<p class="unterminated>text',
    '<!--',
    '<!-- unterminated comment <p>x</p>',
    '<script>never closed',
    '<table><td>cell outside row<tr>',
    '<ul><li><ul><li><ul><li>deep',
    '<b><i>crossed</b></i>',
    '<td>stray cell</td><tr><th>stray</th></tr>',
    '<li>stray item</li>',
    '&#xFFFFFFFF; &#0; &#55296; &#;',
    '<a href="x"><div><p>block in link</p></div></a>',
    '<svg><p>not html</p></svg>',
    '<html><html><body><body><head><p>x</p></head></body>',
    '<pre>',
    '<table></table>',
    '<p style="color: ; : ; font-size: -3px; margin: auto auto; line-height: x">x</p>',
    '<ol start="banana" type="?"><li>x</li></ol>',
    '<td rowspan="999999" colspan="-4">x</td>',
    '\u0000￿\uD800',
    '<div>'.repeat(3000) + 'deep' + '</div>'.repeat(3000),
    '<b>'.repeat(3000) + 'bold',
    '<p>' + 'x'.repeat(100000) + '</p>',
  ];
  let seed = 7;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const alphabet = ['<', '>', '/', 'p', 'li', 'ul', 'td', 'tr', 'table', 'b', ' ', '"', "'", '=', '&', ';', '#', '!', '-', 'a', 'x', '\n', 'pre', 'div'];
  for (let i = 0; i < 200; i++) {
    let s = '';
    const n = Math.floor(random() * 80);
    for (let k = 0; k < n; k++) s += alphabet[Math.floor(random() * alphabet.length)];
    inputs.push(s);
  }
  for (const input of inputs) {
    const { document, extension } = await load(input);
    assert.ok(document.body.length >= 1, JSON.stringify(input.slice(0, 80)));
    const html = documentToHtml(document, extension);
    assert.ok(html.startsWith('<!DOCTYPE'));
    for (const p of paragraphsIn(document.body)) assert.match(p.attrs['w14:paraId'] ?? '', /^[0-9A-F]{8}$/);
  }
});

test('documents with no extension and odd content still export', async () => {
  const doc = await WordDocument.create();
  doc.body = [para([{ kind: 'hyperlink', url: 'a"b<c', children: [run('x<y & z')], attrs: {} }]), para([run('')])];
  const html = documentToHtml(doc);
  assert.ok(bodyOf(html).includes('<a href="a&quot;b&lt;c">x&lt;y &amp; z</a>'));
  assert.equal((await roundTrip(html)).length > 0, true);
});

// --- Comments -------------------------------------------------------------------------------------

import { commentRanges } from '@word/docx';

/** The text each comment covers, by comment id. */
function coveredText(doc: WordDocument): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, range] of commentRanges(paragraphsIn(doc.body))) out.set(id, paragraphText(range.start.paragraph).slice(range.start.offset, range.end.offset).replace(/￼/g, ''));
  return out;
}

test('comments: <mark class="comment"> imports as a comment, a plain <mark> stays a highlight', async () => {
  const { document } = await htmlToDocument(
    '<p>Say <mark class="comment" data-comment-id="7" data-author="Ann" data-initials="A" data-date="2024-05-01T10:00:00Z" data-comment="One&#10;Two &amp; three">hello <b>world</b></mark> and <mark>marked</mark> <!-- ignored -->end</p>',
  );
  assert.deepEqual(document.comments, [{ id: '0', author: 'Ann', initials: 'A', date: '2024-05-01T10:00:00Z', paragraphs: ['One', 'Two & three'] }]);
  assert.equal(coveredText(document).get('0'), 'hello world');
  const marked = runs(paragraphs(document)[0].children).find((r) => runText(r) === 'marked')!;
  assert.equal(marked.properties.highlight, 'yellow');
  assert.equal(paragraphText(paragraphs(document)[0]).replace(/￼/g, ''), 'Say hello world and marked end');
});

test('comments: replies, resolved, title as text, comment on the first and last word', async () => {
  const { document } = await htmlToDocument(
    '<p><mark class="comment" data-comment-id="a" data-resolved="true" title="Bob: first"><mark class="comment" data-comment-id="b" data-parent="a" data-author="Cy" data-comment="reply">First</mark></mark> middle <mark class="comment" data-comment-id="c" data-comment="x">last</mark></p>',
  );
  assert.equal(document.comments.length, 3);
  assert.equal(document.comments[0].resolved, true);
  assert.deepEqual(document.comments[0].paragraphs, ['Bob: first']);
  assert.equal(document.comments[1].parentId, '0');
  assert.equal(coveredText(document).get('1'), 'First');
  assert.equal(coveredText(document).get('2'), 'last');
});

test('comments: export shape and round trip', async () => {
  const source = await markdownToDocument('A **bold {==and plain==}{>>@Ann (2024-05-01T10:00:00Z): a "q" <b>\\nline 2<<}{>>↳ @Bob: ok<<} text** end {==z==}{>>✓ hi<<}');
  const html = documentToHtml(source);
  assert.match(html, /<mark class="comment" data-comment-id="0" data-author="Ann" data-initials="A" data-date="2024-05-01T10:00:00Z" data-comment="a &quot;q&quot; &lt;b&gt;&#10;line 2" title="Ann: a &quot;q&quot; &lt;b&gt;&#10;line 2"><mark class="comment" data-comment-id="1" data-author="Bob" data-initials="B" data-parent="0" data-comment="ok" title="Bob: ok"><strong>and plain<\/strong><\/mark><\/mark>/);
  assert.match(html, /<mark class="comment" data-comment-id="2" data-resolved="true" data-comment="hi" title="hi">z<\/mark>/);
  const { document } = await htmlToDocument(html);
  assert.deepEqual(document.comments.map(({ initials: _i, ...c }) => c), source.comments.map(({ initials: _i, ...c }) => c));
  assert.equal(documentToHtml(document), html);
  assert.deepEqual([...coveredText(document).values()], [...coveredText(source).values()]);
});

test('comments: documents without comments are unchanged', async () => {
  const { document } = await htmlToDocument('<p>a <mark>b</mark> c</p>');
  assert.ok(!documentToHtml(document).includes('class="comment"'));
});

// --- Hostile input -------------------------------------------------------------------------------

test('a file of unfinished tags is read in linear time, its text kept', async () => {
  const source = '<a b '.repeat(20000);
  const started = performance.now();
  const { document } = await load(source);
  assert.ok(performance.now() - started < 3000, 'took too long');
  assert.ok(texts(document)[0].startsWith('<a b <a b'));
});

test('CSS and attribute values naming Object members are not taken as table entries', async () => {
  const { document } = await load('<p style="color: constructor; font-family: constructor; margin-top: 1constructor; font-size: toString">x</p><ol type="constructor"><li>item</li></ol>');
  const [p, item] = paragraphs(document);
  const run = runOf(p, 'x');
  assert.equal(run.properties.color, undefined);
  // A family that isn't a generic one is a font name, taken as written.
  assert.equal(run.properties.fonts?.ascii, 'constructor');
  assert.equal(p.properties.spacing, undefined);
  const numId = item.properties.numbering!.id;
  const abstractId = document.numbering.instances.find((i) => i.id === numId)!.abstractId;
  assert.equal(document.numbering.abstracts.find((a) => a.id === abstractId)!.levels[0].format, 'decimal');
});

test('a font name cannot end the generated style block', async () => {
  const document = await WordDocument.create();
  const evil = 'Evil</style><script>alert(1)</script>';
  document.styles.defaultRunProperties = { fonts: { ascii: evil, hAnsi: evil } };
  document.styles.hasRunDefaults = true;
  document.body = [{ kind: 'paragraph', properties: {}, children: [{ kind: 'run', properties: {}, content: [{ kind: 'text', text: 'hi' }], attrs: {} }], attrs: {} }];
  const html = documentToHtml(document);
  assert.ok(!html.includes('<script>'), html);
  assert.equal(html.split('</style>').length, 2);
});
