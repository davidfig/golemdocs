// Built-in sample documents, constructed through the same DOCX model as opened files so
// every document takes one path: model -> layout -> renderer.

import { WordDocument, type Paragraph, type Run, type RunProperties } from '@word/docx';
import type { FontSet } from '@word/layout';

const run = (text: string, properties: RunProperties = {}): Run => ({
  kind: 'run',
  properties,
  content: [{ kind: 'text', text }],
  attrs: {},
});

const paragraph = (children: Run[], style?: string): Paragraph => ({
  kind: 'paragraph',
  properties: style ? { style } : {},
  children,
  attrs: {},
});

const SAMPLE =
  'The quick brown fox jumps over the lazy dog. Sphinx of black quartz, judge my vow! ' +
  'Typography in a word processor has to match the original exactly: every advance width, ' +
  'line height and page break depends on it. Numbers 0123456789, punctuation (“quotes”, ‘apostrophes’, ' +
  'dashes – and —, ellipses…) and accents: café, naïve, façade, Ångström, Ærøskøbing, Łódź, € 1.234,56.';

/** Every font family and face we ship, in its Word name. */
export async function fontShowcase(fonts: FontSet): Promise<WordDocument> {
  const doc = await WordDocument.create();
  const body: Paragraph[] = [paragraph([run('Fonts')], 'Title')];
  for (const family of fonts.families) {
    const name = family.wordName;
    const face = (props: RunProperties): RunProperties => ({ ...props, fonts: { ascii: name, hAnsi: name, cs: name } });
    body.push(paragraph([run(`${name} – ${family.substitute}`, face({}))], 'Heading1'));
    const variants: [string, RunProperties][] = [
      ['Regular', {}],
      ['Bold', { bold: true }],
      ['Italic', { italic: true }],
      ['Bold Italic', { bold: true, italic: true }],
    ];
    for (const [label, props] of variants) body.push(paragraph([run(`${label}: ${SAMPLE}`, face(props))]));
    for (const alias of Object.keys(family.aliases)) {
      body.push(paragraph([run(`${alias}: ${SAMPLE}`, { fonts: { ascii: alias, hAnsi: alias, cs: alias } })]));
    }
  }
  doc.body = body;
  return doc;
}

/**
 * Hard-wrapped plain text (e.g. Project Gutenberg) as a document: paragraphs at blank lines,
 * short all-caps lines as headings.
 */
export async function plainTextDocument(source: string): Promise<WordDocument> {
  const doc = await WordDocument.create();
  const body: Paragraph[] = [];
  for (const block of source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
    const text = block.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const heading = text.length <= 60 && /[A-Z]/.test(text) && text === text.toUpperCase();
    body.push(paragraph([run(text)], heading ? 'Heading1' : undefined));
  }
  doc.body = body;
  return doc;
}
