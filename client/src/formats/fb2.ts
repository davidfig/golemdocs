// FictionBook 2 (.fb2, the e-book format common in Eastern Europe) <-> outline (see outline.ts and
// xmlOutline.ts). Reads every body (the book, then its notes): nested sections whose titles are
// headings, paragraphs, quotes (cite, epigraph, annotation), poems (a stanza is a paragraph, its
// lines line breaks), tables and inline strong, emphasis, strikethrough, code, sub- and
// superscripts and links; "* * *" subtitles are horizontal rules. Pictures and the description
// (author, genre, cover) are left out. FictionBook has no lists or code blocks, so on the way out a
// list item is a paragraph that starts with its bullet or number and a code block is paragraphs of
// code; a heading 1 the document starts with (its only one) is the body's title.

import type { XmlElement } from '@golemdocs/docx';
import type { DocumentProperties } from '@golemdocs/docx';
import type { ListItem, Node, Span } from './outline.ts';
import {
  attr,
  child,
  documentTitle,
  elements,
  escapeAttr,
  escapeText,
  inlineXml,
  local,
  plainText,
  readXml,
  sectionTree,
  textContent,
  XmlOutlineReader,
  type InlineKind,
  type MarkTags,
  type Section,
} from './xmlOutline.ts';

/** A subtitle of only stars (or dashes, dots...) is a scene break. */
const RULE = /^[\s*·•~\-–—.]+$/;

/** A title's paragraphs ("Chapter 1", "The Beginning") as one line. */
function titleOf(e: XmlElement): XmlElement | undefined {
  const title = child(e, 'title');
  return title && { ...title, children: elements(title).flatMap((p, i) => (i ? [' ', p] : [p])) };
}

class Fb2Reader extends XmlOutlineReader {
  protected inline(e: XmlElement): InlineKind {
    switch (local(e)) {
      case 'strong':
        return { bold: true };
      case 'emphasis':
        return { italic: true };
      case 'strikethrough':
        return { strike: true };
      case 'code':
        return { code: true };
      case 'sup':
        return { sup: true };
      case 'sub':
        return { sub: true };
      case 'a': {
        // A link to a note is its number, as text.
        const href = attr(e, 'href');
        return href && attr(e, 'type') !== 'note' ? { link: href } : undefined;
      }
      case 'image':
        return 'skip';
    }
    return undefined;
  }

  protected block(e: XmlElement, out: Node[], level: number, depth: number): boolean {
    switch (local(e)) {
      case 'section':
        this.heading(titleOf(e), out, level + 1);
        this.blocks(e.children, out, level + 1, depth);
        return true;
      case 'p':
      case 'text-author':
        this.paragraph(e, out, level, depth);
        return true;
      case 'subtitle':
        if (RULE.test(textContent(e))) out.push({ t: 'rule' });
        else this.paragraph(e, out, level, depth);
        return true;
      case 'cite':
      case 'epigraph':
      case 'annotation':
        this.quote(e, out, level, depth);
        return true;
      case 'poem':
        this.blocks(elements(e).filter((c) => local(c) !== 'title'), out, level, depth);
        return true;
      case 'stanza': {
        const spans: Span[] = [];
        for (const v of elements(e).filter((c) => local(c) === 'v')) {
          if (spans.length) spans.push({ text: '', br: true });
          spans.push(...this.spans(v.children));
        }
        this.para(spans, out);
        return true;
      }
      case 'table':
        this.table(e, out, level, depth);
        return true;
      case 'title':
      case 'empty-line':
        return true;
    }
    return false;
  }

  book(root: XmlElement): void {
    for (const body of elements(root).filter((c) => local(c) === 'body')) {
      const title = titleOf(body);
      this.heading(title, this.out, 1);
      this.blocks(body.children, this.out, title ? 1 : 0, 1);
    }
  }
}

export function parseFb2(source: string): Node[] {
  const root = readXml(source, 'FictionBook');
  const reader = new Fb2Reader();
  if (local(root) === 'FictionBook') reader.book(root);
  else reader.blocks([root], reader.out, 0);
  return reader.out;
}

// --- Writing -------------------------------------------------------------------------------------

const TAGS: MarkTags = {
  link: (s) => [`<a l:href="${escapeAttr(s.link!)}">`, '</a>'],
  bold: () => ['<strong>', '</strong>'],
  italic: () => ['<emphasis>', '</emphasis>'],
  strike: () => ['<strikethrough>', '</strikethrough>'],
  sup: () => ['<sup>', '</sup>'],
  sub: () => ['<sub>', '</sub>'],
  code: () => ['<code>', '</code>'],
};

// FictionBook has no line break in a paragraph (only in a poem): it reads back as a space.
const inline = (spans: readonly Span[]): string => inlineXml(spans, TAGS, { br: ' ' });

/** A short, stable id for the document (FictionBook wants one): a hash of its text. */
function documentId(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `golemdocs-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export function renderFb2(nodes: readonly Node[], properties: DocumentProperties = {}): string {
  const { title, rest } = documentTitle(nodes);
  const tree = sectionTree(rest);
  const body: string[] = [];
  if (title) body.push(`    <title><p>${inline(title)}</p></title>`);
  // A body holds sections only: what comes before the first heading is a section without a title.
  if (tree.blocks.length) writeSection({ blocks: tree.blocks, sections: [] }, body, '    ');
  for (const s of tree.sections) writeSection(s, body, '    ');
  if (!tree.blocks.length && !tree.sections.length) body.push('    <section><empty-line/></section>');

  const firstHeading = nodes.find((n) => n.t === 'heading');
  const bookTitle = properties.title?.trim() || (firstHeading ? plainText(firstHeading.spans).trim() : '');
  const author = properties.author?.trim() ?? '';
  const description = [
    '  <description>',
    '    <title-info>',
    '      <genre>nonfiction</genre>',
    `      <author><nickname>${escapeText(author)}</nickname></author>`,
    `      <book-title>${escapeText(bookTitle)}</book-title>`,
    '    </title-info>',
    '    <document-info>',
    `      <author><nickname>${escapeText(author)}</nickname></author>`,
    '      <program-used>Golem Docs</program-used>',
    '      <date></date>',
    `      <id>${documentId(body.join('\n'))}</id>`,
    '      <version>1.0</version>',
    '    </document-info>',
    '  </description>',
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">',
    ...description,
    '  <body>',
    ...body,
    '  </body>',
    '</FictionBook>',
    '',
  ].join('\n');
}

/** A section: its title, then its blocks, or (a section holds either) its blocks in a section without a title before the sections under it. */
function writeSection(section: Section, out: string[], indent: string): void {
  out.push(`${indent}<section>`);
  if (section.title) out.push(`${indent}  <title><p>${inline(section.title)}</p></title>`);
  if (section.sections.length && section.blocks.length) writeSection({ blocks: section.blocks, sections: [] }, out, indent + '  ');
  else for (const node of section.blocks) writeBlock(node, out, indent + '  ');
  for (const s of section.sections) writeSection(s, out, indent + '  ');
  if (!section.title && !section.blocks.length && !section.sections.length) out.push(`${indent}  <empty-line/>`);
  out.push(`${indent}</section>`);
}

function writeBlock(node: Node, out: string[], indent: string): void {
  switch (node.t) {
    case 'heading':
      out.push(`${indent}<subtitle>${inline(node.spans)}</subtitle>`);
      return;
    case 'para':
      out.push(`${indent}<p>${inline(node.spans)}</p>`);
      return;
    case 'code':
      for (const line of node.text.split('\n')) out.push(line.trim() ? `${indent}<p><code>${escapeText(line)}</code></p>` : `${indent}<empty-line/>`);
      return;
    case 'quote':
      out.push(`${indent}<cite>`);
      for (const p of node.paras) out.push(`${indent}  <p>${inline(p)}</p>`);
      out.push(`${indent}</cite>`);
      return;
    case 'list':
      writeList(node.items, node.ordered, node.start, out, indent, '');
      return;
    case 'table': {
      out.push(`${indent}<table>`);
      node.rows.forEach((row, r) => {
        const tag = node.header && r === 0 ? 'th' : 'td';
        out.push(`${indent}  <tr>${row.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`);
      });
      out.push(`${indent}</table>`);
      return;
    }
    case 'rule':
      out.push(`${indent}<subtitle>* * *</subtitle>`);
      return;
  }
}

/** A list as paragraphs that start with their bullet or number, nested ones indented with no-break spaces. */
function writeList(items: readonly ListItem[], ordered: boolean, start: number, out: string[], indent: string, prefix: string): void {
  items.forEach((item, i) => {
    const marker = `${prefix}${ordered ? `${start + i}.` : '•'} `;
    out.push(`${indent}<p>${escapeText(marker)}${inline(item.spans)}</p>`);
    for (const c of item.children) {
      if (c.t === 'list') writeList(c.items, c.ordered, c.start, out, indent, `${prefix}    `);
      else writeBlock(c, out, indent);
    }
  });
}
