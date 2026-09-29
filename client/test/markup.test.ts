// LaTeX, AsciiDoc, reStructuredText and Org import/export (src/formats/outline.ts and the four
// syntaxes), through the same handlers the app uses.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphText } from '@word/docx';
import type { Paragraph, Table } from '@word/docx';
import { adoc, org, rst, tex } from '../src/formats/handlers/markup.ts';
import { markdownToDocument } from '../src/formats/markdown.ts';
import { documentToOutline } from '../src/formats/outline.ts';

const fonts = undefined as never;
const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

const FIXTURE = [
  '# Title',
  '',
  'Intro with **bold**, *italic*, `code`, a [link](https://example.com) and 100% of $5 & more_things.',
  '',
  '## Lists',
  '',
  '- one',
  '  - nested a',
  '  - nested b',
  '- two',
  '',
  '1. first',
  '2. second',
  '',
  '### Code and quotes',
  '',
  '```js',
  'const x = 1;',
  '',
  'if (x) { y(); }',
  '```',
  '',
  '> Quoted text',
  '',
  '| Name | Qty |',
  '|------|-----|',
  '| Apple | 3 |',
  '| Pear | 10 |',
  '',
  '---',
  '',
  'The end.',
  '',
].join('\n');

const handlers = { LaTeX: tex, AsciiDoc: adoc, reStructuredText: rst, Org: org };

for (const [name, handler] of Object.entries(handlers)) {
  test(`${name}: a document survives a round trip`, async () => {
    const source = await markdownToDocument(FIXTURE);
    const wanted = documentToOutline(source);
    const file = await handler.write(source, {}, fonts);
    const back = (await handler.read(file)).document;
    const got = documentToOutline(back);
    // Code fences lose their language in formats that have no place for it (Org, AsciiDoc and reST keep it; LaTeX's verbatim doesn't).
    const strip = (nodes: unknown) => JSON.parse(JSON.stringify(nodes, (k, v) => (k === 'lang' ? undefined : v)));
    assert.deepEqual(strip(got), strip(wanted), `${name}\n${str(file)}`);
  });
}

test('marks that a format has no syntax for are kept as text', async () => {
  const source = await markdownToDocument('Some ~~struck~~ text and **bold**.\n');
  const text = str(await rst.write(source, {}, fonts));
  assert.ok(text.includes('struck') && text.includes('**bold**') && !text.includes('~~'));
  for (const handler of [adoc, org, tex]) {
    const outline = documentToOutline((await handler.read(await handler.write(source, {}, fonts))).document);
    assert.ok(JSON.stringify(outline).includes('"strike":true'));
  }
});

test('LaTeX: reads a typical article', async () => {
  const doc = (
    await tex.read(
      bytes(
        String.raw`\documentclass{article}
\usepackage{hyperref}
\title{Paper}
\begin{document}
\maketitle
\section{Intro} % comment
Caf\'e \textbf{bold \emph{both}} and \verb|x_y| plus \$5, 50\% and ${'``'}quotes''.

\begin{enumerate}
\item first
\item second
\end{enumerate}
\begin{tabular}{ll}
A & B \\ \midrule
1 & 2 \\
\end{tabular}
\end{document}`,
      ),
    )
  ).document;
  const outline = documentToOutline(doc);
  assert.equal(outline[0].t, 'heading');
  assert.equal(outline[1].t, 'heading');
  const para = outline[2] as Extract<(typeof outline)[number], { t: 'para' }>;
  assert.ok(para.spans.some((s) => s.text === 'both' && s.bold && s.italic));
  assert.ok(para.spans.some((s) => s.text === 'x_y' && s.code));
  assert.ok(para.spans.map((s) => s.text).join('').startsWith('Café bold both and x_y plus $5, 50% and “quotes”.'));
  const list = outline[3] as Extract<(typeof outline)[number], { t: 'list' }>;
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 2);
  assert.equal((outline[4] as { header: boolean }).header, true);
});

test('LaTeX: keeps math as TeX and escapes text on the way out', async () => {
  const source = await markdownToDocument('Cost is 5$ & 10% of x_1 with $a^2$.\n');
  const text = str(await tex.write(source, {}, fonts));
  assert.ok(text.includes('5\\$ \\& 10\\% of x\\_1'));
  assert.ok(text.includes('$a^2$'));
});

test('AsciiDoc: reads titles, source blocks, lists and tables', async () => {
  const doc = (
    await adoc.read(
      bytes(
        '= Doc\n:toc:\n\n== Part\n\nSome *bold* and _it_ and https://x.org[site].\n\n[source,python]\n----\nprint(1)\n----\n\n* a\n** b\n\n[cols="2*"]\n|===\n|H1 |H2\n\n|c1 |c2\n|===\n',
      ),
    )
  ).document;
  const outline = documentToOutline(doc);
  assert.deepEqual(outline.map((n) => n.t), ['heading', 'heading', 'para', 'code', 'list', 'table']);
  assert.equal((outline[5] as { rows: unknown[] }).rows.length, 2);
});

test('reStructuredText: reads sections by adornment order, literal blocks and grid tables', async () => {
  const doc = (
    await rst.read(
      bytes('Top\n===\n\nSub\n---\n\nText::\n\n    literal\n\n+---+---+\n| a | b |\n+===+===+\n| 1 | 2 |\n+---+---+\n'),
    )
  ).document;
  const outline = documentToOutline(doc);
  assert.deepEqual(outline.map((n) => n.t), ['heading', 'heading', 'para', 'code', 'table']);
  assert.equal((outline[1] as { level: number }).level, 2);
});

test('Org: reads headings without keywords or tags, lists, and tables', async () => {
  const doc = (
    await org.read(bytes('#+TITLE: T\n* TODO Head :tag:\n- item *b*\n  - sub\n\n| a | b |\n|---+---|\n| 1 | 2 |\n')),
  ).document;
  const outline = documentToOutline(doc);
  assert.deepEqual(outline.map((n) => n.t), ['heading', 'heading', 'list', 'table']);
  const heading = doc.body.filter((b): b is Paragraph => b.kind === 'paragraph').map(paragraphText);
  assert.equal(heading[1], 'Head');
  assert.equal((doc.body.find((b) => b.kind === 'table') as Table).rows.length, 2);
});

test('empty and odd input never throws', async () => {
  for (const handler of Object.values(handlers)) {
    for (const input of ['', '\n\n', '\\', '{', '*', '|', '::', '\\begin{itemize}', '= ', '+---+']) {
      const { document } = await handler.read(bytes(input));
      await handler.write(document, {}, fonts);
    }
  }
});
