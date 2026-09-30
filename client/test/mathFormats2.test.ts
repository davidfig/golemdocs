// Equations in Markdown, HTML, plain text and RTF.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMathInline, paragraphsIn, parseLatex, mathInline, readMathInline, WordDocument, type Paragraph } from '@word/docx';
import { documentToHtml, htmlToDocument } from '../src/formats/html.ts';
import { documentToMarkdown, markdownToDocument } from '../src/formats/markdown.ts';
import { documentToText } from '../src/formats/plainText.ts';
import { documentToRtf } from '../src/formats/rtfExport.ts';

const equations = (doc: WordDocument) => paragraphsIn(doc.body).flatMap((p) => p.children.filter(isMathInline).map(readMathInline));
const run = (text: string) => ({ kind: 'run' as const, properties: {}, attrs: {}, content: [{ kind: 'text' as const, text }] });
const paragraph = (...children: Paragraph['children']): Paragraph => ({ kind: 'paragraph', properties: {}, attrs: {}, children });
const equation = (latex: string, display = false) => mathInline(parseLatex(latex, display).equation);

async function documentWith(...children: Paragraph['children']): Promise<WordDocument> {
  const doc = await WordDocument.create();
  doc.body = [paragraph(...children)];
  return doc;
}

test('Markdown: $…$ and $$…$$ are equations, and prices are not', async () => {
  const doc = await markdownToDocument('The formula $x^2+y^2=z^2$ and $$\\frac{a}{b}$$ cost $5 and $10, or $a b$.\n');
  const found = equations(doc);
  assert.deepEqual(found.map((e) => e.display), [false, true]);
  const text = paragraphsIn(doc.body)[0].children.map((c) => (c.kind === 'run' ? c.content.map((i) => (i.kind === 'text' ? i.text : '')).join('') : '')).join('');
  assert.equal(text, 'The formula  and  cost $5 and $10, or $a b$.');
});

test('Markdown: equations are written as $…$ and read back as the same equations', async () => {
  const doc = await documentWith(run('Area '), equation('\\pi r^2'), run(' and '), equation('\\frac{a}{b}', true));
  const md = documentToMarkdown(doc);
  assert.match(md, /Area \$\\pi r\^2\$ and \$\$\\frac\{a\}\{b\}\$\$/);
  assert.deepEqual(equations(await markdownToDocument(md)), equations(doc));
});

test('Markdown: text that looks like an equation is escaped so it stays text', async () => {
  const doc = await documentWith(run('Costs $a_1 and b_1$ each, and $5 too.'), equation('x^2'));
  const md = documentToMarkdown(doc);
  assert.match(md, /\\\$a_1 and b_1\\\$ each, and \\\$5 too\./);
  const back = await markdownToDocument(md);
  assert.equal(equations(back).length, 1);
  assert.ok(paragraphsIn(back.body)[0].children.some((c) => c.kind === 'run' && c.content.some((i) => i.kind === 'text' && i.text.includes('$a_1 and b_1$'))));
});

test('HTML: an equation is written as MathML and read back', async () => {
  const doc = await documentWith(run('See '), equation('\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}'), run(' and '), equation('\\sum_{i=1}^{n} i', true));
  const html = documentToHtml(doc);
  assert.match(html, /<math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML" display="inline">/);
  assert.match(html, /<mfrac>/);
  assert.match(html, /display="block"/);
  const back = (await htmlToDocument(html)).document;
  const [first, second] = equations(back);
  assert.deepEqual(first, equations(doc)[0]);
  assert.equal(second.display, true);
  assert.equal(second.content[0].type, 'nary');
});

test('plain text and RTF write an equation as its LaTeX', async () => {
  const doc = await documentWith(run('Area '), equation('\\pi r^2'), run(' done'));
  assert.equal(documentToText(doc), 'Area $\\pi r^2$ done');
  const rtf = new TextDecoder().decode(await documentToRtf(doc));
  assert.ok(rtf.includes('Area '));
  assert.ok(/\$\\\\pi r\^2\$/.test(rtf), rtf.slice(-400));
});
