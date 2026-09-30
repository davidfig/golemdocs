// Rich Text Format import/export (src/formats/rtfImport.ts, rtfExport.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument, paragraphText } from '@word/docx';
import type { Block, Hyperlink, Paragraph, Run, Table } from '@word/docx';
import { documentToRtf } from '../src/formats/rtfExport.ts';
import { rtfToDocument } from '../src/formats/rtfImport.ts';
import { markdownToDocument } from '../src/formats/markdown.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const paragraphs = (doc: WordDocument): Paragraph[] => doc.body.filter((b): b is Paragraph => b.kind === 'paragraph');
const runs = (p: Paragraph): Run[] => p.children.filter((c): c is Run => c.kind === 'run');
const text = (b: Block): string => (b.kind === 'paragraph' ? paragraphText(b) : '');

test('reads text, character formatting and paragraph breaks', async () => {
  const doc = await rtfToDocument(
    bytes('{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}{\\f1 Courier New;}}{\\colortbl;\\red255\\green0\\blue0;}\\pard Hello \\b bold\\b0  \\i italic\\i0  {\\cf1 red}\\par\\pard\\qc\\fs32\\f1 Centered\\par}'),
  );
  const [a, b] = paragraphs(doc);
  assert.equal(paragraphText(a), 'Hello bold italic red');
  const rs = runs(a);
  assert.equal(rs.find((r) => r.content.some((c) => c.kind === 'text' && c.text === 'bold'))?.properties.bold, true);
  assert.equal(rs.find((r) => r.content.some((c) => c.kind === 'text' && c.text === 'italic'))?.properties.italic, true);
  assert.equal(rs.at(-1)?.properties.color?.val, 'FF0000');
  assert.equal(b.properties.justification, 'center');
  assert.equal(runs(b)[0].properties.size, 32);
  assert.equal(runs(b)[0].properties.fonts?.ascii, 'Courier New');
});

test('decodes \\uN, hex escapes and escaped braces', async () => {
  const doc = await rtfToDocument(bytes("{\\rtf1\\ansi\\ansicpg1252\\uc1 caf\\'e9 \\u8364? \\{x\\} \\u-10179?\\u-8704?}"));
  assert.equal(paragraphText(paragraphs(doc)[0]), 'café € {x} \u{1F600}');
});

test('reads tables', async () => {
  const doc = await rtfToDocument(
    bytes('{\\rtf1\\ansi\\trowd\\cellx3000\\cellx6000\\intbl A\\cell\\intbl B\\cell\\row\\trowd\\cellx3000\\cellx6000\\intbl C\\cell\\intbl D\\cell\\row\\pard After\\par}'),
  );
  const table = doc.body.find((b): b is Table => b.kind === 'table')!;
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.grid, [3000, 3000]);
  const cellText = table.rows.map((r) => (r.kind === 'row' ? r.cells.map((c) => (c.kind === 'cell' ? c.children.map(text).join('') : '')) : []));
  assert.deepEqual(cellText, [['A', 'B'], ['C', 'D']]);
  assert.equal(text(doc.body.at(-1)!), 'After');
});

test('reads hyperlinks and lists', async () => {
  const doc = await rtfToDocument(
    bytes(
      '{\\rtf1\\ansi{\\*\\listtable{\\list\\listtemplateid1{\\listlevel\\levelnfc23}\\listid7}}{\\*\\listoverridetable{\\listoverride\\listid7\\listoverridecount0\\ls1}}' +
        '\\pard\\ls1\\ilvl0 one\\par\\pard\\ls1\\ilvl0 two\\par\\pard {\\field{\\*\\fldinst HYPERLINK "https://example.com"}{\\fldrslt link}}\\par}',
    ),
  );
  const [one, two, third] = paragraphs(doc);
  assert.ok(one.properties.numbering?.id);
  assert.equal(one.properties.numbering?.id, two.properties.numbering?.id);
  assert.equal(doc.numbering.abstracts[0].levels[0].format, 'bullet');
  const link = third.children.find((c): c is Hyperlink => c.kind === 'hyperlink');
  assert.equal(link?.url, 'https://example.com');
});

test('rejects things that are not RTF', async () => {
  await assert.rejects(() => rtfToDocument(bytes('plain text')));
});

test('a document survives a round trip through RTF', async () => {
  const source = await markdownToDocument(
    '# Title\n\nSome **bold**, *italic* and ~~struck~~ text with a [link](https://example.com).\n\n- one\n- two\n\n1. first\n2. second\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nCafé — “quoted” {braces} \\ backslash\n',
  );
  const rtf = await documentToRtf(source);
  const back = await rtfToDocument(rtf);
  const wanted = paragraphs(source).map(paragraphText).filter(Boolean);
  const got = paragraphs(back).map(paragraphText).filter(Boolean);
  assert.deepEqual(got, wanted);
  const heading = paragraphs(back).find((p) => paragraphText(p) === 'Title')!;
  assert.equal(heading.properties.style, 'Heading1');
  assert.equal(paragraphs(back).filter((p) => p.properties.numbering).length, 4);
  const table = back.body.find((b): b is Table => b.kind === 'table')!;
  assert.equal(table.rows.length, 2);
  const link = paragraphs(back).flatMap((p) => p.children).find((c): c is Hyperlink => c.kind === 'hyperlink');
  assert.equal(link?.url, 'https://example.com');
  const boldRun = paragraphs(back).flatMap(runs).find((r) => r.content.some((c) => c.kind === 'text' && c.text === 'bold'));
  assert.equal(boldRun?.properties.bold, true);
});

test('RTF written starts with the signature and escapes non-ASCII', async () => {
  const doc = await WordDocument.create();
  doc.body = [{ kind: 'paragraph', properties: {}, children: [{ kind: 'run', properties: {}, content: [{ kind: 'text', text: 'é€' }], attrs: {} }], attrs: {} }];
  const out = new TextDecoder().decode(await documentToRtf(doc));
  assert.ok(out.startsWith('{\\rtf1'));
  assert.ok(out.includes('\\u233?\\u8364?'));
  assert.ok(/^[\x00-\x7f]*$/.test(out));
});

// --- Comments (annotations) ---------------------------------------------------------------

/** The text between a comment's markers, across paragraphs (in document order), and where its reference sits. */
function rangeText(doc: WordDocument, id: string): { text: string; references: number } {
  let inside = false;
  let text = '';
  let references = 0;
  const visit = (inlines: readonly import('@word/docx').Inline[]) => {
    for (const inline of inlines) {
      if (inline.kind === 'raw' && inline.xml.attrs['w:id'] === id) {
        if (inline.xml.name === 'w:commentRangeStart') inside = true;
        else if (inline.xml.name === 'w:commentRangeEnd') inside = false;
      } else if (inline.kind === 'run') {
        for (const c of inline.content) {
          if (c.kind === 'text' && inside) text += c.text;
          if (c.kind === 'raw' && c.xml.name === 'w:commentReference' && c.xml.attrs['w:id'] === id) references++;
        }
      } else if (inline.kind === 'hyperlink' || inline.kind === 'wrapper') visit(inline.children);
    }
  };
  for (const p of paragraphs(doc)) visit(p.children);
  return { text, references };
}

const DTTM = (y: number, mo: number, d: number, h: number, mi: number) => (mi | (h << 6) | (d << 11) | (mo << 16) | ((y - 1900) << 20)) >>> 0;

const ANNOTATED =
  '{\\rtf1\\ansi\\deff0 \\pard One {\\*\\atrfstart 5}two three{\\*\\atrfend 5}{\\*\\atnid AB}{\\*\\atnauthor Ann Bee}\\chatn' +
  `{\\*\\annotation{\\*\\atnref 5}{\\*\\atndate ${DTTM(2024, 3, 7, 14, 30)}}{\\*\\atnicn}\\pard\\plain {\\chatn }First\\par Second \\'e9 \\u8364? \\{x\\}\\par} tail\\par}`;

test('reads annotations as comments with a range', async () => {
  const doc = await rtfToDocument(bytes(ANNOTATED));
  assert.match(paragraphText(paragraphs(doc)[0]), /^One .*two three.* tail$/);
  assert.equal(doc.comments.length, 1);
  const c = doc.comments[0];
  assert.equal(c.author, 'Ann Bee');
  assert.equal(c.initials, 'AB');
  assert.equal(c.date, '2024-03-07T14:30:00Z');
  assert.deepEqual(c.paragraphs, ['First', 'Second é € {x}']);
  assert.equal(c.parentId, undefined);
  assert.deepEqual(rangeText(doc, c.id), { text: 'two three', references: 1 });
  // The annotation's own text is not in the body.
  assert.ok(!paragraphs(doc).some((p) => paragraphText(p).includes('First')));
});

test('an annotation without a range is an empty one at its reference; replies share the parent range', async () => {
  const doc = await rtfToDocument(
    bytes(
      '{\\rtf1\\ansi Hello {\\*\\atrfstart 1}world{\\*\\atrfend 1}{\\*\\atnauthor A}\\chatn{\\*\\annotation{\\*\\atnref 1}\\pard Parent\\par}' +
        '{\\*\\atnauthor B}\\chatn{\\*\\annotation{\\*\\atnref 2}{\\*\\atnparent 1}\\pard Reply\\par}\\par' +
        '\\pard Later{\\*\\atnauthor C}\\chatn{\\*\\annotation{\\*\\atnref 3}\\pard Loose\\par}\\par}',
    ),
  );
  const [parent, reply, loose] = doc.comments;
  assert.equal(reply.parentId, parent.id);
  assert.deepEqual(rangeText(doc, parent.id), { text: 'world', references: 1 });
  assert.deepEqual(rangeText(doc, reply.id), { text: 'world', references: 1 });
  assert.deepEqual(rangeText(doc, loose.id), { text: '', references: 1 });
  assert.equal(loose.author, 'C');
});

test('an unnamed hidden \\comment destination is still skipped', async () => {
  const doc = await rtfToDocument(bytes('{\\rtf1\\ansi Keep{\\comment hidden note} this\\par}'));
  assert.equal(paragraphText(paragraphs(doc)[0]), 'Keep this');
  assert.equal(doc.comments.length, 0);
});

test('writes comments and reads them back, replies and unicode included', async () => {
  const doc = await rtfToDocument(bytes(ANNOTATED));
  const first = doc.comments[0];
  doc.comments.push({ id: '9', author: 'Zoë 日本', initials: 'Z', date: '2025-12-31T23:59:00Z', paragraphs: ['Reply {a} \\ b', 'ünï'], parentId: first.id });
  // The reply is over the same range as its parent.
  const { commentStart, commentEnd, commentReference, insertInlines } = await import('@word/docx');
  const p = paragraphs(doc)[0];
  const fp = p.children.findIndex((c) => c.kind === 'raw' && c.xml.name === 'w:commentRangeEnd');
  assert.ok(fp > 0);
  const offsets = (await import('@word/docx')).commentMarkerOffsets(p, first.id);
  insertInlines(p, offsets[1], [commentEnd('9'), commentReference('9')]);
  insertInlines(p, offsets[2], [commentStart('9')]);

  const rtf = new TextDecoder().decode(await documentToRtf(doc));
  assert.match(rtf, /\{\\\*\\atrfstart 0\}/);
  assert.match(rtf, /\{\\\*\\atnparent 0\}/);
  assert.match(rtf, /\\atndate \d+\}/);
  const back = await rtfToDocument(bytes(rtf));
  assert.equal(back.comments.length, 2);
  const [a, b] = back.comments;
  assert.deepEqual({ ...a, id: '' }, { ...first, id: '' });
  assert.equal(b.author, 'Zoë 日本');
  assert.equal(b.initials, 'Z');
  assert.equal(b.date, '2025-12-31T23:59:00Z');
  assert.deepEqual(b.paragraphs, ['Reply {a} \\ b', 'ünï']);
  assert.equal(b.parentId, a.id);
  assert.deepEqual(rangeText(back, a.id), { text: 'two three', references: 1 });
  assert.deepEqual(rangeText(back, b.id), { text: 'two three', references: 1 });
  // A second trip is stable.
  const again = await rtfToDocument(bytes(new TextDecoder().decode(await documentToRtf(back))));
  assert.deepEqual(again.comments.map((c) => ({ ...c, id: '' })), back.comments.map((c) => ({ ...c, id: '' })));
});

test('a comment across paragraphs keeps both markers; one on the last word ends at the paragraph end', async () => {
  const doc = await rtfToDocument(
    bytes(
      '{\\rtf1\\ansi First {\\*\\atrfstart 1}para\\par Second{\\*\\atrfend 1}{\\*\\atnauthor A}\\chatn{\\*\\annotation{\\*\\atnref 1}Span\\par} para\\par ' +
        'Last {\\*\\atrfstart 2}word{\\*\\atrfend 2}{\\*\\atnauthor A}\\chatn{\\*\\annotation{\\*\\atnref 2}End\\par}\\par}',
    ),
  );
  const back = await rtfToDocument(await documentToRtf(doc));
  assert.equal(back.comments.length, 2);
  assert.equal(rangeText(back, back.comments[0].id).text, 'para' + 'Second');
  assert.deepEqual(rangeText(back, back.comments[1].id), { text: 'word', references: 1 });
  assert.match(paragraphText(paragraphs(back).at(-1)!), /^Last .*word.*$/);
});

test('a document built from markdown exports with no comments cleanly', async () => {
  const doc = await markdownToDocument('Plain **text**');
  const rtf = new TextDecoder().decode(await documentToRtf(doc));
  assert.ok(!rtf.includes('annotation'));
});

// --- Code pages and hostile input ----------------------------------------------------------------

test('East Asian code pages decode their bytes', async () => {
  const doc = await rtfToDocument(bytes("{\\rtf1\\ansi\\ansicpg932 \\'82\\'a0\\par}"));
  assert.equal(text(doc.body[0]), 'あ');
  const chinese = await rtfToDocument(bytes("{\\rtf1\\ansi\\ansicpg936 \\'c4\\'e3\\par}"));
  assert.equal(text(chinese.body[0]), '你');
});

test('a hex escape needs two hex digits; anything else stays text', async () => {
  const doc = await rtfToDocument(bytes("{\\rtf1 a\\'zzb\\par}"));
  assert.equal(text(doc.body[0]), 'azzb');
});

test('groups nested past any real file still give their text', async () => {
  const depth = 5000;
  const doc = await rtfToDocument(bytes(`{\\rtf1 ${'{'.repeat(depth)}deep${'}'.repeat(depth)} after\\par}`));
  assert.equal(text(doc.body[0]), 'deep after');
});

test('a zero or negative font size keeps the default', async () => {
  const doc = await rtfToDocument(bytes('{\\rtf1 {\\fs0 zero}{\\fs-4 minus}\\par}'));
  for (const run of runs(paragraphs(doc)[0])) assert.equal(run.properties.size, undefined);
});

test('a row of many merged cells is read in linear time', async () => {
  const n = 20000;
  const source = `{\\rtf1 \\trowd\\cellx1000${'\\clmrg\\cellx1000'.repeat(n)} a\\cell ${'\\cell '.repeat(n)}\\row }`;
  const started = performance.now();
  const doc = await rtfToDocument(bytes(source));
  assert.ok(performance.now() - started < 3000, 'took too long');
  const table = doc.body.find((b): b is Table => b.kind === 'table')!;
  assert.equal(table.rows[0].kind === 'row' && table.rows[0].cells.length, 1);
});

test('a link address with a quote and a font name with a semicolon survive a round trip', async () => {
  const doc = await markdownToDocument('[x](http://e.com/?a="b")');
  const link = paragraphs(doc)[0].children[0] as Hyperlink;
  const run = link.children[0] as Run;
  run.properties.fonts = { ascii: 'Odd;Font', hAnsi: 'Odd;Font' };
  const back = await rtfToDocument(await documentToRtf(doc));
  const backLink = paragraphs(back)[0].children.find((c): c is Hyperlink => c.kind === 'hyperlink')!;
  assert.equal(backLink.url, 'http://e.com/?a=%22b%22');
  assert.equal((backLink.children[0] as Run).properties.fonts?.ascii, 'OddFont');
});
