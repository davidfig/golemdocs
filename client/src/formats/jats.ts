// JATS (the Journal Article Tag Suite, the XML of PubMed Central and many journals) <-> outline (see
// outline.ts and xmlOutline.ts). Reads an article's title (a heading 1, with its sections one level
// below), abstract, body and back matter: nested sections, paragraphs, lists, quotes, code,
// tables, formulas (their TeX when they have it), references (one paragraph each) and inline
// bold, italic, underline, strike, monospace, sub- and superscripts and links. Author lists,
// affiliations, journal metadata, footnotes and figures' pictures are left out. Writes JATS 1.3: the
// document's only heading 1 (when it starts with it) is the article title, and a horizontal rule
// is an empty <p content-type="rule"/>, which JATS has no element for.

import type { XmlElement } from '@golemdocs/docx';
import type { Node, Span } from './outline.ts';
import {
  attr,
  child,
  documentTitle,
  elements,
  escapeAttr,
  escapeText,
  inlineXml,
  local,
  readXml,
  sectionTree,
  textContent,
  XmlOutlineReader,
  type InlineKind,
  type MarkTags,
  type Section,
} from './xmlOutline.ts';

const SECTIONS = new Set(['sec', 'abstract', 'trans-abstract', 'ack', 'app', 'app-group', 'ref-list', 'glossary', 'notes', 'bio']);

const CONTAINERS = new Set(['body', 'back', 'boxed-text', 'fig', 'fig-group', 'caption', 'statement', 'table-wrap-foot', 'list-item', 'def', 'supplementary-material', 'sub-article', 'response', 'floats-group']);

const SKIP = new Set([
  'title', 'label', 'xref', 'fn', 'graphic', 'inline-graphic', 'media', 'alternatives', 'object-id', 'permissions', 'alt-text', 'long-desc', 'attrib', 'contrib-group', 'aff',
  'author-notes', 'kwd-group', 'funding-group', 'counts', 'custom-meta-group', 'history', 'pub-date', 'article-id', 'article-categories', 'journal-meta', 'processing-meta',
]);

const BLOCKS = new Set([...SECTIONS, ...CONTAINERS, 'p', 'list', 'def-list', 'disp-quote', 'preformat', 'code', 'table-wrap', 'table', 'disp-formula', 'ref', 'verse-group', 'speech']);

/** The TeX of a formula: its tex-math (without $ or \[ \] around it), or its text. */
function formulaTex(e: XmlElement): string {
  const tex = elements(e).find((c) => local(c) === 'tex-math') ?? elements(child(e, 'alternatives') ?? e).find((c) => local(c) === 'tex-math');
  const text = textContent(tex ?? e).trim();
  if (!tex) return text;
  const body = /\\begin\{document\}([\s\S]*?)\\end\{document\}/.exec(text)?.[1].trim() ?? text;
  return body.replace(/^\$\$?([\s\S]*?)\$\$?$/, '$1').replace(/^\\\[([\s\S]*)\\\]$/, '$1').replace(/^\\\(([\s\S]*)\\\)$/, '$1').trim();
}

class JatsReader extends XmlOutlineReader {
  protected inline(e: XmlElement): InlineKind {
    switch (local(e)) {
      case 'bold':
        return { bold: true };
      case 'italic':
        return { italic: true };
      case 'underline':
        return { underline: true };
      case 'strike':
        return { strike: true };
      case 'monospace':
        return { code: true };
      case 'sup':
        return { sup: true };
      case 'sub':
        return { sub: true };
      case 'ext-link':
      case 'uri':
      case 'self-uri': {
        const href = attr(e, 'href') ?? textContent(e).trim();
        return href ? { link: href } : undefined;
      }
      case 'email':
        return { link: `mailto:${textContent(e).trim()}` };
      case 'break':
        return 'break';
      case 'inline-formula':
        return 'math';
      case 'disp-formula':
        return 'display-math';
    }
    return SKIP.has(local(e)) ? 'skip' : undefined;
  }

  protected math(e: XmlElement): string {
    return formulaTex(e);
  }

  protected block(e: XmlElement, out: Node[], level: number, depth: number): boolean {
    const name = local(e);
    if (SECTIONS.has(name)) {
      this.heading(child(e, 'title'), out, level + 1);
      this.blocks(e.children, out, level + 1, depth);
      return true;
    }
    if (CONTAINERS.has(name)) {
      this.blocks(e.children, out, level, depth);
      return true;
    }
    switch (name) {
      case 'p':
        if (attr(e, 'content-type') === 'rule' && !textContent(e).trim()) out.push({ t: 'rule' });
        else this.paragraph(e, out, level, depth);
        return true;
      case 'list': {
        const type = attr(e, 'list-type') ?? '';
        const items = elements(e).filter((c) => local(c) === 'list-item');
        const label = items[0] && child(items[0], 'label');
        const start = label ? Number(/\d+/.exec(textContent(label))?.[0]) : 1;
        this.list(items, type !== '' && type !== 'bullet' && type !== 'simple', Number.isFinite(start) && start > 0 ? start : 1, out, level, depth);
        return true;
      }
      case 'def-list':
        this.list(elements(e).filter((c) => local(c) === 'def-item'), false, 1, out, level, depth, (item) => {
          const term = child(item, 'term');
          return [{ name: 'p', attrs: {}, children: term?.children ?? [] }, ...elements(item).filter((c) => local(c) === 'def')];
        });
        return true;
      case 'fn-group':
        // A footnote is read where the notes are written out, and left out where it is cited.
        for (const c of elements(e)) this.blocks(local(c) === 'fn' ? c.children : [c], out, level, depth);
        return true;
      case 'disp-quote':
      case 'verse-group':
      case 'speech':
        this.quote(e, out, level, depth);
        return true;
      case 'preformat':
        this.code(e, out, attr(e, 'preformat-type'));
        return true;
      case 'code':
        this.code(e, out, attr(e, 'language'));
        return true;
      case 'table-wrap':
        this.blocks(e.children, out, level, depth);
        return true;
      case 'table':
        this.table(e, out, level, depth);
        return true;
      case 'disp-formula': {
        const tex = formulaTex(e);
        if (tex) out.push({ t: 'para', spans: [{ text: tex, math: 'display' }] });
        return true;
      }
      case 'ref': {
        const label = textContent(child(e, 'label') ?? { name: '', attrs: {}, children: [] }).trim();
        const citation = elements(e).filter((c) => local(c) !== 'label');
        this.para([{ text: `${label ? `${label} ` : ''}${citation.map(textContent).join(' ')}` }], out);
        return true;
      }
    }
    // (What is left out, a citation or footnote in a paragraph, is inline: the paragraph around it stays one.)
    if (SKIP.has(name)) return false;
    if (elements(e).some((c) => BLOCKS.has(local(c)))) {
      this.blocks(e.children, out, level, depth);
      return true;
    }
    return false;
  }

  /** An article: its title, abstracts, body and back matter, in that order. */
  article(article: XmlElement): void {
    const front = child(article, 'front');
    const meta = front && child(front, 'article-meta');
    const title = meta && child(child(meta, 'title-group') ?? meta, 'article-title');
    const hasTitle = !!title && textContent(title).trim() !== '';
    if (hasTitle) this.heading(title, this.out, 1);
    const level = hasTitle ? 1 : 0;
    for (const abstract of meta ? elements(meta).filter((c) => local(c) === 'abstract') : []) this.block(abstract, this.out, level, 1);
    for (const part of elements(article)) {
      const name = local(part);
      if (name === 'body' || name === 'back' || name === 'floats-group') this.blocks(part.children, this.out, level, 1);
      else if (name === 'sub-article' || name === 'response') this.article(part);
    }
  }
}

export function parseJats(source: string): Node[] {
  const root = readXml(source, 'JATS');
  const reader = new JatsReader();
  if (local(root) === 'article' || local(root) === 'sub-article') reader.article(root);
  else reader.blocks([root], reader.out, 0);
  return reader.out;
}

// --- Writing -------------------------------------------------------------------------------------

const TAGS: MarkTags = {
  link: (s) => [`<ext-link ext-link-type="uri" xlink:href="${escapeAttr(s.link!)}">`, '</ext-link>'],
  bold: () => ['<bold>', '</bold>'],
  italic: () => ['<italic>', '</italic>'],
  underline: () => ['<underline>', '</underline>'],
  strike: () => ['<strike>', '</strike>'],
  sup: () => ['<sup>', '</sup>'],
  sub: () => ['<sub>', '</sub>'],
  code: () => ['<monospace>', '</monospace>'],
};

const inline = (spans: readonly Span[]): string =>
  inlineXml(spans, TAGS, {
    br: '<break/>',
    math: (s) => (s.math === 'display' ? `<disp-formula><tex-math>${escapeText(s.text)}</tex-math></disp-formula>` : `<inline-formula><tex-math>${escapeText(s.text)}</tex-math></inline-formula>`),
  });

export function renderJats(nodes: readonly Node[]): string {
  const { title, rest } = documentTitle(nodes);
  const tree = sectionTree(rest);
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE article PUBLIC "-//NLM//DTD JATS (Z39.96) Journal Archiving and Interchange DTD v1.3 20210610//EN" "JATS-archivearticle1-3.dtd">',
    '<article xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:mml="http://www.w3.org/1998/Math/MathML" article-type="other" dtd-version="1.3">',
    '  <front>',
    '    <article-meta>',
    `      <title-group><article-title>${title ? inline(title) : ''}</article-title></title-group>`,
    '    </article-meta>',
    '  </front>',
    '  <body>',
  ];
  writeSection(tree, out, '    ');
  out.push('  </body>', '</article>', '');
  return out.join('\n');
}

function writeSection(section: Section, out: string[], indent: string): void {
  for (const node of section.blocks) writeBlock(node, out, indent);
  for (const s of section.sections) {
    out.push(`${indent}<sec>`);
    if (s.title) out.push(`${indent}  <title>${inline(s.title)}</title>`);
    writeSection(s, out, indent + '  ');
    out.push(`${indent}</sec>`);
  }
}

function writeBlock(node: Node, out: string[], indent: string): void {
  switch (node.t) {
    case 'heading':
      out.push(`${indent}<p>${inline(node.spans.map((s) => ({ ...s, bold: true })))}</p>`);
      return;
    case 'para':
      out.push(`${indent}<p>${inline(node.spans)}</p>`);
      return;
    case 'code':
      out.push(`${indent}<code${node.lang ? ` language="${escapeAttr(node.lang)}"` : ''}>${escapeText(node.text)}</code>`);
      return;
    case 'quote':
      out.push(`${indent}<disp-quote>`);
      for (const p of node.paras) out.push(`${indent}  <p>${inline(p)}</p>`);
      out.push(`${indent}</disp-quote>`);
      return;
    case 'list':
      out.push(`${indent}<list list-type="${node.ordered ? 'order' : 'bullet'}">`);
      node.items.forEach((item, i) => {
        // JATS has no start number: a list that doesn't count from 1 has its numbers as labels.
        const label = node.ordered && node.start !== 1 ? `<label>${node.start + i}.</label>` : '';
        out.push(`${indent}  <list-item>${label}`, `${indent}    <p>${inline(item.spans)}</p>`);
        for (const c of item.children) writeBlock(c, out, indent + '    ');
        out.push(`${indent}  </list-item>`);
      });
      out.push(`${indent}</list>`);
      return;
    case 'table': {
      const row = (cells: Span[][], tag: string) => `${indent}      <tr>${cells.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`;
      out.push(`${indent}<table-wrap>`, `${indent}  <table>`);
      const body = node.header ? node.rows.slice(1) : node.rows;
      if (node.header && node.rows.length) out.push(`${indent}    <thead>`, row(node.rows[0], 'th'), `${indent}    </thead>`);
      if (body.length) out.push(`${indent}    <tbody>`, ...body.map((r) => row(r, 'td')), `${indent}    </tbody>`);
      out.push(`${indent}  </table>`, `${indent}</table-wrap>`);
      return;
    }
    case 'rule':
      out.push(`${indent}<p content-type="rule"/>`);
      return;
  }
}
