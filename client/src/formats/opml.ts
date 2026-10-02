// OPML (the outline format of outliners such as OmniOutliner, Workflowy and Logseq, and of feed
// readers' subscription lists) <-> outline (see outline.ts). An OPML file is a tree of one-line
// entries, so it opens as its title (a heading 1) over a nested bulleted list: each entry an item,
// its note (`_note`) paragraphs under it, and a link entry (or a feed) a link. On the way out the
// document's headings are the tree: what comes under a heading is entries under its entry, a list's
// items are entries with their nested lists under them, and the paragraphs of an item are its note.
// Text is plain: marks, other than a paragraph that is a single link, are not kept.

import type { DocumentProperties } from '@golemdocs/docx';
import type { ListItem, Node, Span } from './outline.ts';
import { attr, child, documentTitle, elements, escapeAttr, local, plainText, readXml, sectionTree, textContent, type Section } from './xmlOutline.ts';
import type { XmlElement } from '@golemdocs/docx';

/** Entries nested deeper than this are read as entries at this depth. */
const MAX_DEPTH = 32;

/** An entry's text: outliners sometimes keep a little HTML formatting in it, which is dropped. */
const entryText = (text: string): string =>
  text
    .replace(/<\/?(b|i|u|s|em|strong|span|a|br|code|mark|del|ins|sup|sub)\b[^>]*>/gi, '')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();

function entries(parent: XmlElement, depth: number): ListItem[] {
  const items: ListItem[] = [];
  for (const e of elements(parent).filter((c) => local(c) === 'outline')) {
    const text = entryText(attr(e, 'text') ?? attr(e, 'title') ?? '');
    const link = attr(e, 'url') ?? attr(e, 'htmlUrl') ?? attr(e, 'xmlUrl');
    const spans: Span[] = text ? [{ text, ...(link && { link }) }] : link ? [{ text: link, link }] : [];
    const children: Node[] = [];
    for (const para of (attr(e, '_note') ?? '').split(/\r?\n\s*\r?\n/)) {
      const line = para.replace(/\s+/g, ' ').trim();
      if (line) children.push({ t: 'para', spans: [{ text: line }] });
    }
    const nested = entries(e, depth + 1);
    if (nested.length) {
      // Past the deepest level, the entries below join this one's list.
      if (depth >= MAX_DEPTH) {
        items.push({ spans, children }, ...nested);
        continue;
      }
      children.push({ t: 'list', ordered: false, start: 1, items: nested });
    }
    items.push({ spans, children });
  }
  return items;
}

export function parseOpml(source: string): Node[] {
  const root = readXml(source, 'OPML');
  const out: Node[] = [];
  const head = child(root, 'head');
  const titleElement = head && child(head, 'title');
  const title = titleElement ? entryText(textContent(titleElement)) : '';
  if (title) out.push({ t: 'heading', level: 1, spans: [{ text: title }] });
  const items = entries(child(root, 'body') ?? root, 0);
  if (items.length) out.push({ t: 'list', ordered: false, start: 1, items });
  return out;
}

// --- Writing -------------------------------------------------------------------------------------

/** An entry's attributes: its text, and a link when all of it is one. */
function entryAttrs(spans: readonly Span[]): string {
  const text = plainText(spans).replace(/\s+/g, ' ').trim();
  const link = spans.length > 0 && spans.every((s) => s.link && s.link === spans[0].link) ? spans[0].link : undefined;
  return `text="${escapeAttr(text)}"${link ? ` type="link" url="${escapeAttr(link)}"` : ''}`;
}

export function renderOpml(nodes: readonly Node[], properties: DocumentProperties = {}): string {
  const { title, rest } = documentTitle(nodes);
  const head = properties.title?.trim() || (title ? plainText(title).trim() : '');
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<opml version="2.0">', '  <head>', `    <title>${escapeAttr(head)}</title>`, '  </head>', '  <body>'];
  writeSection(sectionTree(title ? rest : nodes), out, '    ');
  out.push('  </body>', '</opml>', '');
  return out.join('\n');
}

function writeSection(section: Section, out: string[], indent: string): void {
  for (const node of section.blocks) writeBlock(node, out, indent);
  for (const s of section.sections) {
    const inner: string[] = [];
    writeSection(s, inner, indent + '  ');
    // A level that is skipped has no entry of its own: what is under it is under the entry above.
    if (!s.title) out.push(...inner.map((line) => line.slice(2)));
    else if (inner.length) out.push(`${indent}<outline ${entryAttrs(s.title)}>`, ...inner, `${indent}</outline>`);
    else out.push(`${indent}<outline ${entryAttrs(s.title)}/>`);
  }
}

function writeBlock(node: Node, out: string[], indent: string): void {
  switch (node.t) {
    case 'heading':
    case 'para':
      out.push(`${indent}<outline ${entryAttrs(node.spans)}/>`);
      return;
    case 'code':
      out.push(`${indent}<outline text="${escapeAttr(node.text)}"/>`);
      return;
    case 'quote':
      for (const p of node.paras) out.push(`${indent}<outline ${entryAttrs(p)}/>`);
      return;
    case 'table':
      for (const row of node.rows) out.push(`${indent}<outline text="${escapeAttr(row.map((c) => plainText(c).trim()).join(' | '))}"/>`);
      return;
    case 'list':
      for (const item of node.items) {
        const notes = item.children.filter((c): c is Extract<Node, { t: 'para' }> => c.t === 'para').map((c) => plainText(c.spans).trim());
        const note = notes.length ? ` _note="${escapeAttr(notes.join('\n\n'))}"` : '';
        const inner: string[] = [];
        for (const c of item.children) if (c.t !== 'para') writeBlock(c, inner, indent + '  ');
        if (inner.length) out.push(`${indent}<outline ${entryAttrs(item.spans)}${note}>`, ...inner, `${indent}</outline>`);
        else out.push(`${indent}<outline ${entryAttrs(item.spans)}${note}/>`);
      }
      return;
    case 'rule':
      return;
  }
}
