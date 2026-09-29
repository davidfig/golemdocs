// Markdown import/export (src/formats/markdown.ts).
// Run: node --experimental-transform-types --test test/markdown.test.ts
// (the flag is only needed because @word/docx uses TypeScript parameter properties.)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StyleResolver, WordDocument, paragraphText } from '@word/docx';
import type { Block, Hyperlink, Inline, Paragraph, Run, Table } from '@word/docx';
import { documentToMarkdown, markdownToDocument } from '../src/formats/markdown.ts';

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
const runText = (r: Run): string => r.content.map((c) => (c.kind === 'text' ? c.text : c.kind === 'tab' ? '\t' : '')).join('');

const roundTrip = async (md: string): Promise<string> => documentToMarkdown(await markdownToDocument(md));

/** Export is a fixed point after one normalisation: md -> doc -> md -> doc -> md is stable. */
async function assertStable(md: string, expected?: string): Promise<string> {
  const once = await roundTrip(md);
  const twice = await roundTrip(once);
  assert.equal(twice, once, `unstable round trip for ${JSON.stringify(md)}`);
  if (expected !== undefined) assert.equal(once, expected);
  return once;
}

// --- Import ---------------------------------------------------------------------------------------

test('empty input gives one empty paragraph and empty output', async () => {
  for (const src of ['', '\n', '   \n\n  ', '\ufeff']) {
    const doc = await markdownToDocument(src);
    assert.equal(doc.body.length, 1);
    assert.equal(doc.body[0].kind, 'paragraph');
    assert.equal(documentToMarkdown(doc), '');
  }
});

test('ATX and setext headings map to Heading1..Heading6 styles', async () => {
  const doc = await markdownToDocument('# One\n## Two ##\n### Three\n#### Four\n##### Five\n###### Six\n####### Seven\n\nSetext\n======\n\nSub\n---\n');
  assert.deepEqual(styles(doc), ['Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6', undefined, 'Heading1', 'Heading2']);
  assert.deepEqual(texts(doc), ['One', 'Two', 'Three', 'Four', 'Five', 'Six', '####### Seven', 'Setext', 'Sub']);
  // The styles exist in the document's stylesheet so they lay out as headings.
  const ids = new Set(doc.styles.styles.map((s) => s.id));
  for (const id of ['Heading1', 'Heading4', 'Heading5', 'Heading6']) assert.ok(ids.has(id), id);
  const resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
  assert.equal(resolver.paragraph({ style: 'Heading5' }).outlineLevel, 4);
});

test('a "#" without a space is text, and empty headings are allowed', async () => {
  const doc = await markdownToDocument('#hashtag\n\n#\n');
  assert.deepEqual(styles(doc), [undefined, 'Heading1']);
  assert.equal(texts(doc)[0], '#hashtag');
});

test('paragraphs join soft-wrapped lines with a space and honour hard breaks', async () => {
  const doc = await markdownToDocument('one\ntwo  \nthree\\\nfour\n\nsecond');
  assert.equal(doc.body.length, 2);
  const first = paragraphs(doc)[0];
  const contents = runs(first.children).flatMap((r) => r.content);
  assert.deepEqual(
    contents.map((c) => (c.kind === 'text' ? c.text : c.kind)),
    ['one two', 'break', 'three', 'break', 'four'],
  );
});

test('emphasis, strong, strikethrough and code become run properties', async () => {
  const doc = await markdownToDocument('plain **bold** *italic* ***both*** ~~gone~~ `code` **bold `code`**');
  const rs = runs(paragraphs(doc)[0].children);
  const by = (t: string) => rs.find((r) => runText(r) === t)!;
  assert.equal(by('bold').properties.bold, true);
  assert.equal(by('italic').properties.italic, true);
  assert.equal(by('both').properties.bold, true);
  assert.equal(by('both').properties.italic, true);
  assert.equal(by('gone').properties.strike, true);
  assert.equal(by('plain ').properties.bold, undefined);
  const code = by('code');
  assert.equal(code.properties.style, 'InlineCode');
  assert.equal(code.properties.fonts?.ascii, 'Courier New');
  const boldCode = rs.filter((r) => r.properties.style === 'InlineCode' && r.properties.bold);
  assert.equal(boldCode.length, 1);
  assert.ok(doc.styles.styles.some((s) => s.id === 'InlineCode' && s.type === 'character'));
});

test('intraword underscores are literal; unmatched delimiters stay literal', async () => {
  const doc = await markdownToDocument('snake_case_name and 2 * 3 and *open and **open2 and a ~ b and ~~x');
  assert.equal(texts(doc)[0], 'snake_case_name and 2 * 3 and *open and **open2 and a ~ b and ~~x');
  for (const r of runs(paragraphs(doc)[0].children)) assert.equal(r.properties.bold, undefined);
});

test('backslash escapes and entities', async () => {
  const doc = await markdownToDocument('\\*not em\\* \\# \\[x\\] \\\\ &amp; &lt;tag&gt; &#65;&#x42; &unknown; a\\qb');
  assert.equal(texts(doc)[0], '*not em* # [x] \\ & <tag> AB &unknown; a\\qb');
});

test('links: inline, reference, autolink, emphasis inside', async () => {
  const doc = await markdownToDocument(
    '[a **b**](http://x.com/a_(b) "title") [ref][r] [r] <https://auto.example> <me@ex.org>\n\n[r]: <http://ref.example/x y>\n',
  );
  const links = paragraphs(doc)[0].children.filter((c): c is Hyperlink => c.kind === 'hyperlink');
  assert.deepEqual(
    links.map((l) => l.url),
    ['http://x.com/a_(b)', 'http://ref.example/x y', 'http://ref.example/x y', 'https://auto.example', 'mailto:me@ex.org'],
  );
  const first = runs(links[0].children);
  assert.equal(first.map(runText).join(''), 'a b');
  assert.equal(first[1].properties.bold, true);
  assert.equal(first[0].properties.style, 'Hyperlink');
  assert.ok(doc.styles.styles.some((s) => s.id === 'Hyperlink'));
  // Definitions are consumed, not shown.
  assert.equal(doc.body.length, 1);
});

test('links do not nest and unresolved references are literal', async () => {
  const doc = await markdownToDocument('[a [b](u1) c](u2) and [nope] and [also][missing]');
  const links = paragraphs(doc)[0].children.filter((c) => c.kind === 'hyperlink');
  assert.equal(links.length, 1);
  // Inner link wins ("a ", link "b", " c"), the outer brackets and destination stay text.
  assert.equal(texts(doc)[0], '[a b c](u2) and [nope] and [also][missing]');
});

test('images become link placeholders and export back as images', async () => {
  const doc = await markdownToDocument('see ![the **alt**](pic.png "t") and ![](b.png)');
  const links = paragraphs(doc)[0].children.filter((c): c is Hyperlink => c.kind === 'hyperlink');
  assert.equal(links.length, 2);
  assert.equal(runs(links[0].children).map(runText).join(''), '[Image: the alt]');
  assert.equal(runs(links[1].children).map(runText).join(''), '[Image]');
  assert.equal(documentToMarkdown(doc), 'see ![the alt](pic.png) and ![](b.png)\n');
});

test('bullet lists: real numbering, nesting levels, ListParagraph style', async () => {
  const doc = await markdownToDocument('- a\n- b\n  - c\n    - d\n- e\n');
  const ps = paragraphs(doc);
  assert.deepEqual(texts(doc), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(ps.map((p) => p.properties.numbering?.level), [0, 0, 1, 2, 0]);
  assert.ok(ps.every((p) => p.properties.style === 'ListParagraph'));
  const resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
  for (const p of ps) {
    const ref = p.properties.numbering!;
    assert.ok(ref.id && ref.id > 0);
    assert.equal(resolver.listLevel(ref.id, ref.level ?? 0)?.format, 'bullet');
  }
  // Nested lists have their own definitions but every level of every definition is valid.
  assert.ok(doc.numbering.abstracts.every((a) => a.levels.length === 9));
  assert.equal(new Set(ps.map((p) => p.properties.numbering!.id)).size, 3);
});

test('ordered lists: start number, delimiter kinds, restart between lists', async () => {
  const doc = await markdownToDocument('3. three\n4. four\n   1. sub\n   2. sub2\n\ntext\n\n1. again\n');
  const ps = paragraphs(doc);
  const resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
  const first = ps[0].properties.numbering!;
  assert.equal(resolver.listLevel(first.id!, 0)?.format, 'decimal');
  assert.equal(resolver.listLevel(first.id!, 0)?.start, 3);
  assert.equal(resolver.listLevel(ps[2].properties.numbering!.id!, 1)?.format, 'lowerLetter');
  const again = ps[ps.length - 1].properties.numbering!;
  assert.notEqual(again.id, first.id);
  assert.equal(resolver.listLevel(again.id!, 0)?.start, 1);
});

test('list items may hold several paragraphs, code and quotes', async () => {
  const doc = await markdownToDocument('1. item\n\n   continued\n\n   ```\n   code\n   ```\n\n2. next\n');
  const ps = paragraphs(doc);
  assert.deepEqual(texts(doc), ['item', 'continued', 'code', 'next']);
  assert.equal(ps[0].properties.numbering?.level, 0);
  assert.equal(ps[1].properties.numbering, undefined);
  assert.equal(ps[1].properties.style, 'ListParagraph');
  assert.equal(ps[2].properties.style, 'Code');
  assert.equal(ps[3].properties.numbering?.id, ps[0].properties.numbering?.id);
});

test('lists interrupt paragraphs only as CommonMark says', async () => {
  const doc = await markdownToDocument('para\n- item\n\npara2\n2. not a list\n');
  assert.deepEqual(texts(doc), ['para', 'item', 'para2 2. not a list']);
});

test('block quotes use the Quote style, with nesting indent', async () => {
  const doc = await markdownToDocument('> one\n> two\n\n> > deep\n>\n> back\n\nlazy\n> quoted\ncontinues\n');
  assert.deepEqual(styles(doc), ['Quote', 'Quote', 'Quote', undefined, 'Quote']);
  assert.deepEqual(texts(doc), ['one two', 'deep', 'back', 'lazy', 'quoted continues']);
  assert.equal(paragraphs(doc)[1].properties.indent?.left, 720);
  assert.ok(doc.styles.styles.some((s) => s.id === 'Quote'));
});

test('fenced and indented code blocks become Code paragraphs, one per line', async () => {
  const doc = await markdownToDocument('```ts\nlet a = 1;\n\n\tindented()\n```\n\n~~~\ntilde `x`\n~~~\n\n    indented\n      more\n\nafter');
  assert.deepEqual(styles(doc), ['Code', 'Code', 'Code', 'Code', 'Code', 'Code', undefined]);
  assert.deepEqual(texts(doc), ['let a = 1;', '', '\uFFFCindented()', 'tilde `x`', 'indented', '  more', 'after']);
  // Tabs are tab content, not text, and code is not parsed for inline syntax.
  const tabbed = paragraphs(doc)[2].children[0] as Run;
  assert.deepEqual(tabbed.content.map((c) => c.kind), ['tab', 'text']);
  assert.ok(doc.styles.styles.some((s) => s.id === 'Code' && s.type === 'paragraph'));
});

test('an unterminated fence runs to the end', async () => {
  const doc = await markdownToDocument('```\nopen\nstill code');
  assert.deepEqual(styles(doc), ['Code', 'Code']);
});

test('horizontal rules are bordered empty paragraphs', async () => {
  const doc = await markdownToDocument('a\n\n---\n\n***\n\n___\n\n- - -\n\nb');
  const ps = paragraphs(doc);
  assert.equal(ps.length, 6);
  for (const p of ps.slice(1, 5)) {
    assert.equal(p.children.length, 0);
    assert.equal(p.properties.borders?.bottom?.val, 'single');
  }
});

test('GFM tables become model tables with header row and alignment', async () => {
  const doc = await markdownToDocument('| Name | Qty | Note |\n|:-----|:---:|-----:|\n| a `x\\|y` | 1 | **b** |\n| c | 2 |\n\nafter');
  const [table] = tables(doc);
  assert.ok(table);
  assert.equal(table.grid.length, 3);
  assert.equal(table.rows.length, 3);
  const cells = (r: number) => (table.rows[r] as { cells: { children: Paragraph[] }[] }).cells.map((c) => paragraphText(c.children[0]));
  assert.deepEqual(cells(0), ['Name', 'Qty', 'Note']);
  assert.deepEqual(cells(1), ['a x|y', '1', 'b']);
  assert.deepEqual(cells(2), ['c', '2', '']);
  assert.equal((table.rows[0] as { properties: { header?: boolean } }).properties.header, true);
  const just = (table.rows[1] as { cells: { children: Paragraph[] }[] }).cells.map((c) => c.children[0].properties.justification);
  assert.deepEqual(just, ['left', 'center', 'right']);
  assert.deepEqual(texts(doc), ['after']);
});

test('table-ish text that is not a table stays a paragraph', async () => {
  const doc = await markdownToDocument('a | b\nno delimiter row\n\n| x |\n| - | - |\n');
  assert.equal(tables(doc).length, 0);
});

test('footnotes, task boxes and raw HTML stay literal', async () => {
  const doc = await markdownToDocument('Text[^1]\n\n[^1]: the note\n\n- [ ] todo\n\n<div>html</div>');
  assert.deepEqual(texts(doc), ['Text[^1]', '[^1]: the note', '[ ] todo', '<div>html</div>']);
});

test('CRLF, CR and a BOM are normalised', async () => {
  const doc = await markdownToDocument('\ufeff# T\r\n\r\ntext\rmore\r\n- a\r\n- b\r\n');
  assert.deepEqual(texts(doc), ['T', 'text more', 'a', 'b']);
});

test('the document written by markdownToDocument is a valid docx', async () => {
  const doc = await markdownToDocument('# T\n\n- a\n  1. b\n\n> q\n\n`c` [l](http://x.example)\n\n| a |\n|---|\n| b |\n');
  const back = await WordDocument.read(await doc.write());
  assert.equal(documentToMarkdown(back), documentToMarkdown(doc));
  assert.ok(back.numbering.instances.length >= 2);
});

// --- Export ---------------------------------------------------------------------------------------

async function build(...blocks: Block[]): Promise<WordDocument> {
  const doc = await WordDocument.create();
  doc.body = blocks;
  return doc;
}
const run = (text: string, properties: Run['properties'] = {}): Run => ({ kind: 'run', properties, content: [{ kind: 'text', text }], attrs: {} });
const para = (children: Inline[], properties: Paragraph['properties'] = {}): Paragraph => ({ kind: 'paragraph', properties, children, attrs: {} });

test('export: merges adjacent runs with identical formatting, skips empty runs', async () => {
  const doc = await build(
    para([run('a', { bold: true }), run('b', { bold: true }), run('', { italic: true }), run(' c'), run('', { bold: true, italic: true })]),
  );
  assert.equal(documentToMarkdown(doc), '**ab** c\n');
});

test('export: whitespace moves outside markers; marks nest without crossing', async () => {
  const doc = await build(
    para([
      run('x ', { bold: true }),
      run(' y', { bold: true, italic: true }),
      run('z', { italic: true }),
      run(' s', { strike: true }),
    ]),
  );
  const md = documentToMarkdown(doc);
  // "x " + " y" keeps both spaces (outside the markers); "***" closes italic then bold, and the
  // following italic uses "_" so its opener cannot fuse with that run.
  assert.equal(md, '**x  *y***_z_ ~~s~~\n');
  const back = await markdownToDocument(md);
  const rs = runs(paragraphs(back)[0].children);
  assert.deepEqual(
    rs.map((r) => [runText(r), !!r.properties.bold, !!r.properties.italic, !!r.properties.strike]),
    [
      ['x  ', true, false, false],
      ['y', true, true, false],
      ['z', false, true, false],
      [' ', false, false, false],
      ['s', false, false, true],
    ],
  );
});

test('export: only the text of unsupported formatting survives', async () => {
  const doc = await build(
    para([run('red', { color: { val: 'FF0000' } }), run(' under', { underline: { val: 'single' }, fonts: { ascii: 'Arial' }, size: 40 })], {
      justification: 'center',
    }),
  );
  assert.equal(documentToMarkdown(doc), 'red under\n');
});

test('export: heading styles, title, outline levels', async () => {
  const doc = await markdownToDocument('# a\n\n## b\n\n###### f');
  assert.equal(documentToMarkdown(doc), '# a\n\n## b\n\n###### f\n');
  const custom = await build(para([run('Doc')], { style: 'Title' }), para([run('x')], { style: 'Heading2' }));
  assert.equal(documentToMarkdown(custom), '# Doc\n\n## x\n');
  const outlined = await build(para([run('by outline')], { outlineLevel: 2 }));
  assert.equal(documentToMarkdown(outlined), '### by outline\n');
});

test('export: monospace runs are code, backtick-safe', async () => {
  const doc = await build(para([run('a '), run('x`y', { fonts: { ascii: 'Consolas' } }), run(' b '), run('``', { style: 'InlineCode' })]));
  assert.equal(documentToMarkdown(doc), 'a ``x`y`` b ``` `` ```\n');
});

test('export: escaping keeps literal text literal', async () => {
  const literal = [
    '*star*',
    '_under_',
    'a_b_c',
    '# not heading',
    '1. not list',
    '- not bullet',
    '+ plus',
    '> not quote',
    '[not](link)',
    '[a][b]',
    '`tick`',
    '<b>x</b>',
    '&amp; &copy',
    '~~strike~~',
    'back\\slash \\* mix',
    '====',
    '---',
    '| pipe |',
    '![img](x)',
    '<https://x.example>',
    '2) paren',
  ];
  for (const text of literal) {
    const doc = await build(para([run(text)]));
    const md = documentToMarkdown(doc);
    const back = await markdownToDocument(md);
    assert.deepEqual(texts(back), [text], `${JSON.stringify(text)} -> ${JSON.stringify(md)}`);
    assert.deepEqual(styles(back), [undefined], `${JSON.stringify(text)} must stay a plain paragraph`);
    assert.ok(runs(paragraphs(back)[0].children).every((r) => !r.properties.bold && !r.properties.italic && !r.properties.strike));
  }
});

test('export: literal text at every line start of a hard-broken paragraph is escaped', async () => {
  const doc = await build(
    para([run('first'), { kind: 'run', properties: {}, content: [{ kind: 'break' }], attrs: {} }, run('# second')]),
  );
  const md = documentToMarkdown(doc);
  assert.equal(md, 'first\\\n\\# second\n');
  const back = await markdownToDocument(md);
  assert.equal(back.body.length, 1);
});

test('export: hyperlinks, autolinks and anchors', async () => {
  const link = (url: string, text: string): Hyperlink => ({ kind: 'hyperlink', url, children: [run(text)], attrs: {} });
  const doc = await build(
    para([link('http://a.example/x_(y)', 'a [b]'), run(' '), link('https://plain.example', 'https://plain.example'), run(' '), link('has space', 'sp')]),
  );
  // Destinations with parentheses or spaces are written in <...> form; brackets in link text are escaped.
  assert.equal(documentToMarkdown(doc), '[a \\[b\\]](<http://a.example/x_(y)>) <https://plain.example> [sp](<has space>)\n');
  const anchor = await build(para([{ kind: 'hyperlink', anchor: 'sec', children: [run('jump')], attrs: {} }]));
  assert.equal(documentToMarkdown(anchor), '[jump](#sec)\n');
});

test('export: lists number correctly, nest with indentation and keep lists apart', async () => {
  const md = '- a\n  - b\n    - c\n  - d\n- e\n\n1. x\n2. y\n   1. z\n\ntext\n\n5. five\n6. six\n';
  const once = await roundTrip(md);
  assert.equal(once, md);
});

test('export: consecutive distinct lists stay distinct', async () => {
  await assertStable('- a\n- b\n\n* c\n* d\n', '- a\n- b\n\n* c\n* d\n');
  await assertStable('1. a\n2. b\n\n1) c\n2) d\n', '1. a\n2. b\n\n1) c\n2) d\n');
  const doc = await markdownToDocument('- a\n- b\n* c\n');
  assert.equal(new Set(paragraphs(doc).map((p) => p.properties.numbering!.id)).size, 2);
});

test('export: list item continuation paragraphs and multi-line items', async () => {
  const md = '- one\\\n  two\n\n  para\n\n- next\n';
  assert.equal(await roundTrip(md), md);
});

test('export: block quotes and code blocks', async () => {
  const md = '> a\n>\n> b\n\n```\nx\n\n  y\n```\n\ntext\n';
  assert.equal(await roundTrip(md), md);
  const fenced = await roundTrip('````\n```\ninner\n```\n````\n');
  assert.equal(fenced, '````\n```\ninner\n```\n````\n');
});

test('export: tables, alignment, escaped pipes, breaks and padding', async () => {
  const md = '| a | b |\n| :--- | ---: |\n| x \\| y | 2 |\n| p | `q` |\n';
  assert.equal(await roundTrip(md), md);
  assert.equal(await roundTrip('|a|b|c|\n|-|:-:|-|\n|1|\n'), '| a | b | c |\n| --- | :---: | --- |\n| 1 |   |   |\n');
  const merged = await markdownToDocument('| a | b |\n|---|---|\n| x | y |');
  const cell = (tables(merged)[0].rows[1] as { cells: { children: Paragraph[] }[] }).cells[0];
  cell.children.push(para([run('second')]));
  assert.equal(documentToMarkdown(merged), '| a | b |\n| --- | --- |\n| x<br>second | y |\n');
});

test('export: tables built by hand (spans, empty cells, nested text)', async () => {
  const cell = (text: string, gridSpan?: number) => ({
    kind: 'cell' as const,
    properties: gridSpan ? { gridSpan } : {},
    children: [para(text ? [run(text)] : [])],
    attrs: {},
  });
  const table: Table = {
    kind: 'table',
    properties: {},
    grid: [1, 1, 1],
    rows: [
      { kind: 'row', properties: {}, cells: [cell('h1', 2), cell('h3')], attrs: {} },
      { kind: 'row', properties: {}, cells: [cell('a'), cell(''), cell('c')], attrs: {} },
    ],
  };
  assert.equal(documentToMarkdown(await build(table)), '| h1 |   | h3 |\n| --- | --- | --- |\n| a |   | c |\n');
});

test('export: horizontal rule and page/section noise', async () => {
  const doc = await markdownToDocument('a\n\n---\n\nb');
  assert.equal(documentToMarkdown(doc), 'a\n\n---\n\nb\n');
  const withBreak = await build(
    para([run('one'), { kind: 'run', properties: {}, content: [{ kind: 'break', type: 'page' }], attrs: {} }, run('two')]),
    para([]),
    para([run('three')]),
  );
  assert.equal(documentToMarkdown(withBreak), 'onetwo\n\nthree\n');
});

// --- Round trips ----------------------------------------------------------------------------------

const SAMPLE = `# Project *Notes*

Intro paragraph with **bold**, *italic*, ~~struck~~, \`inline code\` and a [link](https://example.com/a_b).
A soft-wrapped second line, then a hard break\\
and a third.

## Lists

- alpha
- beta
  - nested one
  - nested two
    1. deep ordered
    2. deeper ordered
- gamma

3. three
4. four

> A quote
> over two lines

\`\`\`
code block
  indented
\`\`\`

| Col A | Col B |
| :--- | ---: |
| 1 | 2 |

---

Final paragraph with 1\\. escaped and a literal \\*star\\*.
`;

test('round trip of a mixed document is stable', async () => {
  const once = await assertStable(SAMPLE);
  // Structure survives: headings, lists, quote, code, table, rule and marks.
  const doc = await markdownToDocument(once);
  assert.ok(styles(doc).includes('Heading2'));
  assert.equal(tables(doc).length, 1);
  assert.ok(paragraphs(doc).some((p) => p.properties.style === 'Quote'));
  assert.ok(paragraphs(doc).some((p) => p.properties.style === 'Code'));
  assert.ok(once.includes('**bold**') && once.includes('*italic*') && once.includes('~~struck~~') && once.includes('`inline code`'));
  assert.ok(once.includes('[link](https://example.com/a_b)'));
  assert.ok(once.includes('    1. deep ordered\n    2. deeper ordered'));
});

test('round trip through a written and re-read docx is unchanged', async () => {
  const doc = await markdownToDocument(SAMPLE);
  const back = await WordDocument.read(await doc.write());
  assert.equal(documentToMarkdown(back), documentToMarkdown(doc));
});

test('assorted constructs are stable', async () => {
  for (const md of [
    '***both***\n',
    '**a *b* c** and *x **y** z*\n',
    'a  \nb\n',
    '* a\n\n  para\n\n* b\n',
    '> > deep\n> back\n',
    '1. a\n1. b\n1. c\n',
    '`` `tick` ``\n',
    '[ref][r]\n\n[r]: http://x.example\n',
    '<https://auto.example>\n',
    '![alt text](a b.png)\n',
    'Setext\n===\n',
    '\\# esc \\* esc \\[x](y)\n',
    '- [ ] task\n- [x] done\n',
    'Text[^1]\n\n[^1]: note\n',
  ]) {
    await assertStable(md);
  }
});

// --- Robustness -----------------------------------------------------------------------------------

test('odd input never throws and degrades to text', async () => {
  const inputs = [
    '[',
    ']',
    '![',
    '![]()',
    '[]()',
    '[a](',
    '[a](<',
    '](x)',
    '`',
    '``',
    '```',
    '*',
    '**',
    '~~',
    '<',
    '<a',
    '&',
    '&#',
    '&#99999999999;',
    '\\',
    '|',
    '|-|',
    '| a |\n|---|\n',
    '> ',
    '>',
    '-',
    '- ',
    '1.',
    '1. ',
    '- - - -',
    '- \n- \n',
    '* * *',
    '#',
    '\t',
    '\t\t- x',
    '   - a\n      - b\n\t- c',
    '- a\n\n\n\n- b',
    'a\n-\nb',
    '[x]: \n',
    '[x]:\n[x]',
    '[^a]: [^b]: [^c]',
    '\u0000\u0001\ufffd',
    '😀 **😀** _😀_',
    '> '.repeat(1000) + 'deep',
    '- '.repeat(1000) + 'deep',
    '*'.repeat(10000),
    '[' .repeat(5000) + ']'.repeat(5000),
    '| a |\n|---|\n'.repeat(50),
  ];
  for (const src of inputs) {
    const doc = await markdownToDocument(src);
    assert.ok(doc.body.length >= 1);
    documentToMarkdown(doc);
    await doc.write();
  }
});

test('pathological large inputs finish quickly (linear-ish)', async () => {
  const rep = (s: string, bytes = 1 << 20) => s.repeat(Math.ceil(bytes / s.length));
  const inputs: Record<string, string> = {
    plain: rep('The quick brown fox jumps over the lazy dog.\n'),
    stars: rep('*a '),
    nestedEmphasis: rep('*a ', 200000) + rep('a* ', 200000),
    brackets: rep('['),
    bracketPairs: rep('[a](b'),
    links: rep('[a](b) '),
    backticks: rep('`a '),
    quotes: rep('> ', 100000) + 'x',
    lists: rep('- ', 200000) + 'x',
    listItems: rep('- item\n'),
    orderedItems: rep('1. item\n'),
    table: '| a | b |\n|---|---|\n' + rep('| 1 | 2 |\n'),
    code: '```\n' + rep('code line\n') + '```\n',
    setext: rep('a\n---\n'),
  };
  // Coverage instrumentation makes hot loops about 20 times slower; quadratic behaviour is still far beyond this.
  const slowdown = process.execArgv.some((a) => a.includes('coverage')) || process.env.NODE_V8_COVERAGE ? 30 : 1;
  const started = performance.now();
  for (const [name, src] of Object.entries(inputs)) {
    const t0 = performance.now();
    const doc = await markdownToDocument(src);
    const md = documentToMarkdown(doc);
    const took = performance.now() - t0;
    assert.ok(md.length > 0, name);
    // Generous ceiling: these take well under a second each; quadratic behaviour would take minutes.
    assert.ok(took < 8000 * slowdown, `${name} took ${took.toFixed(0)}ms`);
  }
  assert.ok(performance.now() - started < 60000 * slowdown);
});
