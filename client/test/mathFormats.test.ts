// Equations in the text formats: read into the document as equations, written back as source.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMathInline, mathAt, paragraphsIn, readMathInline, type Paragraph } from '@word/docx';
import { adoc, org, rst, tex } from '../src/formats/handlers/markup.ts';
import { documentToOutline } from '../src/formats/outline.ts';

const fonts = undefined as never;
const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

const SOURCE = String.raw`\documentclass{article}
\begin{document}
The formula $x^2+y^2=z^2$ holds, and \(a+b\) too.

\[ \frac{-b \pm \sqrt{b^2-4ac}}{2a} \]

\begin{align}
a &= b \\
c &= d
\end{align}

A price of \$5 is not math.
\end{document}`;

const equations = (paragraphs: Paragraph[]) => paragraphs.flatMap((p) => p.children.filter(isMathInline).map(readMathInline));

test('LaTeX: $…$, \\(…\\), \\[…\\] and align are read as equations', async () => {
  const doc = (await tex.read(bytes(SOURCE))).document;
  const found = equations(paragraphsIn(doc.body));
  assert.equal(found.length, 4);
  assert.deepEqual(found.map((e) => e.display), [false, false, true, true]);
  assert.equal(found[2].content[0].type, 'frac');
  assert.equal(found[3].content[0].type, 'eqArray');
  // Text around them stays text, and an escaped dollar sign isn't math.
  const texts = paragraphsIn(doc.body).map((p) => p.children.map((c) => (c.kind === 'run' ? c.content.map((i) => (i.kind === 'text' ? i.text : '')).join('') : '')).join(''));
  assert.equal(texts[0], 'The formula  holds, and  too.');
  assert.ok(texts.some((t) => t === 'A price of $5 is not math.'));
});

test('LaTeX: equations are written back as source and read again as the same equations', async () => {
  const first = (await tex.read(bytes(SOURCE))).document;
  const written = str(await tex.write(first, {}, fonts));
  assert.match(written, /\$x\^2\+y\^2=z\^2\$/);
  assert.match(written, /\\\[\\frac\{-b\\pm \\sqrt\{b\^2-4ac\}\}\{2a\}\\\]/);
  const second = (await tex.read(bytes(written))).document;
  assert.deepEqual(equations(paragraphsIn(second.body)), equations(paragraphsIn(first.body)));
});

test('an equation is one position in a paragraph, and an outline keeps its LaTeX and display', async () => {
  const doc = (await tex.read(bytes('See $x^2$ now.\n'))).document;
  const [paragraph] = paragraphsIn(doc.body);
  assert.ok(mathAt(paragraph, 4));
  const outline = documentToOutline(doc);
  const para = outline[0] as Extract<(typeof outline)[number], { t: 'para' }>;
  assert.deepEqual(para.spans.map((s) => [s.text, s.math ?? null]), [['See ', null], ['x^2', 'inline'], [' now.', null]]);
});

test('formats without a syntax of their own for equations write them as $…$', async () => {
  const doc = (await tex.read(bytes('An equation $x^2$ and\n\n\\[\\alpha\\]\n'))).document;
  for (const handler of [adoc, org, rst]) {
    const text = str(await handler.write(doc, {}, fonts));
    assert.ok(text.includes('$x^2$'), text);
    assert.ok(text.includes('$$\\alpha$$'), text);
  }
});
