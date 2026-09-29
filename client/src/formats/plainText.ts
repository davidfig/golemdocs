// Plain text <-> document model. Unlike `plainTextDocument` in layout/samples.ts (a heuristic for
// hard-wrapped Gutenberg books), this is for genuinely editable .txt files: one paragraph per
// line, nothing inferred, and `documentToText(await textToDocument(s)) === s` for any `s`
// (after CRLF/CR normalisation and BOM removal).

import { ListCounter, StyleResolver, WordDocument } from '@word/docx';
import type { Block, Inline, Paragraph, RunContent, Table } from '@word/docx';

const MONOSPACE = 'Courier New';

/**
 * A document with one paragraph per line of `source`. Blank lines are empty paragraphs, tabs stay
 * tabs, no styles are applied. A trailing newline yields a final empty paragraph, so the text
 * round-trips exactly. The document's default font is monospace.
 */
export async function textToDocument(source: string): Promise<WordDocument> {
  const doc = await WordDocument.create();
  const text = (source.charCodeAt(0) === 0xfeff ? source.slice(1) : source).replace(/\r\n?/g, '\n');
  const body: Block[] = [];
  let start = 0;
  for (;;) {
    const end = text.indexOf('\n', start);
    body.push(linePara(end < 0 ? text.slice(start) : text.slice(start, end)));
    if (end < 0) break;
    start = end + 1;
  }
  doc.body = body;

  // Monospace, single-spaced defaults so lines look like a text file.
  const defaults = doc.styles.defaultRunProperties ?? (doc.styles.defaultRunProperties = {});
  defaults.fonts = { ...defaults.fonts, ascii: MONOSPACE, hAnsi: MONOSPACE, eastAsia: MONOSPACE, cs: MONOSPACE };
  doc.styles.hasRunDefaults = true;
  const paragraphDefaults = doc.styles.defaultParagraphProperties ?? (doc.styles.defaultParagraphProperties = {});
  paragraphDefaults.spacing = { ...paragraphDefaults.spacing, after: 0, line: 240, lineRule: 'auto' };
  doc.styles.hasParagraphDefaults = true;
  return doc;
}

function linePara(line: string): Paragraph {
  const content: RunContent[] = [];
  let start = 0;
  for (;;) {
    const tab = line.indexOf('\t', start);
    const part = tab < 0 ? line.slice(start) : line.slice(start, tab);
    if (part) content.push({ kind: 'text', text: part });
    if (tab < 0) break;
    content.push({ kind: 'tab' });
    start = tab + 1;
  }
  return {
    kind: 'paragraph',
    properties: {},
    children: content.length ? [{ kind: 'run', properties: {}, content, attrs: {} }] : [],
    attrs: {},
  };
}

/**
 * The document as plain text: paragraphs joined with '\n'; table rows one per line with cells
 * separated by tabs; list items prefixed with their label ("- ", "1. ", "(a) ") and indented two
 * spaces per level; line breaks as '\n', tabs as '\t'. Everything else is dropped, its text kept.
 */
export function documentToText(doc: WordDocument): string {
  const resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
  const counter = new ListCounter(resolver);
  const lines: string[] = [];

  const label = (p: Paragraph): string => {
    const numbering = resolver.paragraph(p.properties).numbering;
    const l = counter.next(numbering);
    if (!l) return '';
    const level = resolver.listLevel(numbering?.id, l.level);
    const text = level?.format === 'bullet' ? '-' : l.text;
    return text ? `${'  '.repeat(l.level)}${text} ` : '';
  };

  // `sink` receives paragraph text; table cells flatten it onto one line.
  const walk = (blocks: readonly Block[], out: string[]): void => {
    for (const block of blocks) {
      switch (block.kind) {
        case 'paragraph':
          out.push(label(block) + inlineText(block.children));
          break;
        case 'table':
          tableLines(block, out);
          break;
        case 'wrapper':
          walk(block.children, out);
          break;
        case 'raw':
          break;
      }
    }
  };

  const tableLines = (table: Table, out: string[]): void => {
    for (const row of table.rows) {
      if (row.kind !== 'row') continue;
      const cells: string[] = [];
      for (const cell of row.cells) {
        if (cell.kind !== 'cell') continue;
        const inner: string[] = [];
        walk(cell.children, inner);
        cells.push(inner.join(' ').replace(/\n/g, ' '));
        for (let s = (cell.properties.gridSpan ?? 1) - 1; s > 0; s--) cells.push('');
      }
      out.push(cells.join('\t'));
    }
  };

  walk(doc.body, lines);
  return lines.join('\n');
}

function inlineText(inlines: readonly Inline[]): string {
  let out = '';
  for (const inline of inlines) {
    switch (inline.kind) {
      case 'run':
        for (const item of inline.content) {
          switch (item.kind) {
            case 'text':
              out += item.text;
              break;
            case 'tab':
              out += '\t';
              break;
            case 'break':
              if (!item.type || item.type === 'textWrapping') out += '\n';
              break;
            case 'cr':
              out += '\n';
              break;
            case 'noBreakHyphen':
              out += '-';
              break;
            default:
              break;
          }
        }
        break;
      case 'hyperlink':
      case 'wrapper':
        out += inlineText(inline.children);
        break;
      case 'raw':
        break;
    }
  }
  return out;
}
