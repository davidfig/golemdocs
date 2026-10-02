// DocBook <-> outline (see outline.ts and xmlOutline.ts). Reads DocBook 5 and 4 (with or without the
// namespace): books, articles and any of their parts, whose nested sections' titles are headings;
// paragraphs, the list kinds, program listings, block quotes, CALS and HTML tables, and inline
// emphasis, literals, sub- and superscripts, links and equations. Admonitions, examples and figures
// are read as the blocks in them; indexes, footnotes, remarks and pictures are left out. Writes
// DocBook 5: an article whose title is the document's only heading 1 (when it starts with it),
// sections for headings, and a horizontal rule as an empty <para role="rule"/>, which DocBook has no
// element for.

import type { XmlElement, XmlNode } from '@golemdocs/docx';
import { finishSpans } from './outline.ts';
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

const SECTIONS = new Set([
  'set', 'book', 'part', 'reference', 'article', 'chapter', 'appendix', 'preface', 'section', 'simplesect', 'topic', 'dedication', 'acknowledgements', 'colophon',
  'sect1', 'sect2', 'sect3', 'sect4', 'sect5', 'refentry', 'refsynopsisdiv', 'refsection', 'refsect1', 'refsect2', 'refsect3', 'bibliography', 'bibliodiv', 'glossary', 'glossdiv',
]);

/** Elements that hold blocks and are read as the blocks in them. */
const CONTAINERS = new Set([
  'note', 'tip', 'warning', 'caution', 'important', 'danger', 'sidebar', 'example', 'informalexample', 'figure', 'informalfigure', 'abstract', 'partintro', 'highlights',
  'legalnotice', 'task', 'tasksummary', 'taskprerequisites', 'taskrelated', 'qandaset', 'qandadiv', 'qandaentry', 'question', 'answer', 'listitem', 'glossdef', 'attribution', 'textobject',
]);

const CODE = new Set([
  'literal', 'code', 'command', 'filename', 'computeroutput', 'userinput', 'varname', 'function', 'classname', 'option', 'envar', 'parameter', 'prompt', 'systemitem', 'tag', 'markup',
  'constant', 'type', 'methodname', 'property', 'sgmltag', 'keycode', 'returnvalue', 'exceptionname', 'interfacename', 'package', 'token', 'symbol', 'database', 'varargs',
]);

const ITALIC = new Set(['replaceable', 'citetitle', 'firstterm', 'foreignphrase', 'wordasword', 'glossterm', 'citation']);

const SKIP = new Set([
  'title', 'titleabbrev', 'subtitle', 'info', 'indexterm', 'remark', 'footnote', 'footnoteref', 'anchor', 'beginpage', 'xref', 'co', 'coref', 'annotation', 'inlinemediaobject',
  'mediaobject', 'imageobject', 'imagedata', 'graphic', 'inlinegraphic', 'screenshot', 'toc', 'lot', 'index', 'setindex', 'funcsynopsis', 'cmdsynopsis', 'alt',
]);

/** Block elements the reader knows, so an unknown element holding any of them is read as a container. */
const BLOCKS = new Set([
  ...SECTIONS, ...CONTAINERS, 'para', 'simpara', 'formalpara', 'bridgehead', 'itemizedlist', 'orderedlist', 'simplelist', 'variablelist', 'glosslist', 'procedure', 'substeps',
  'calloutlist', 'stepalternatives', 'programlisting', 'screen', 'synopsis', 'literallayout', 'address', 'blockquote', 'epigraph', 'table', 'informaltable', 'equation',
  'informalequation', 'biblioentry', 'bibliomixed', 'glossentry', 'refnamediv',
]);

const isInfo = (e: XmlElement): boolean => local(e) === 'info' || /^[a-z0-9]+info$/.test(local(e));

/** A section's title: its own, or in its info (DocBook 4's chapterinfo and so on). */
function titleOf(e: XmlElement): XmlElement | undefined {
  const own = child(e, 'title');
  if (own) return own;
  for (const c of elements(e)) if (isInfo(c)) return child(c, 'title');
  return undefined;
}

const para = (children: XmlNode[]): XmlElement => ({ name: 'para', attrs: {}, children });

class DocbookReader extends XmlOutlineReader {
  protected inline(e: XmlElement): InlineKind {
    const name = local(e);
    if (name === 'emphasis') {
      const role = (attr(e, 'role') ?? '').toLowerCase();
      if (role === 'bold' || role === 'strong') return { bold: true };
      if (role === 'underline') return { underline: true };
      if (role === 'strikethrough' || role === 'strike' || role === 'line-through') return { strike: true };
      return { italic: true };
    }
    if (CODE.has(name)) return { code: true };
    if (ITALIC.has(name)) return { italic: true };
    if (name === 'superscript') return { sup: true };
    if (name === 'subscript') return { sub: true };
    if (name === 'link' || name === 'olink') {
      const href = attr(e, 'href') ?? (attr(e, 'linkend') ? `#${attr(e, 'linkend')}` : undefined);
      return href ? { link: href } : undefined;
    }
    if (name === 'ulink') return attr(e, 'url') ? { link: attr(e, 'url') } : undefined;
    if (name === 'uri') return { link: textContent(e).trim() };
    if (name === 'email') return { link: `mailto:${textContent(e).trim()}` };
    if (name === 'inlineequation') return 'math';
    if (SKIP.has(name) || isInfo(e)) return 'skip';
    return undefined;
  }

  protected math(e: XmlElement): string {
    const alt = elements(e).find((c) => local(c) === 'alt') ?? elements(e).find((c) => local(c) === 'mathphrase');
    return textContent(alt ?? e).trim();
  }

  protected block(e: XmlElement, out: Node[], level: number, depth: number): boolean {
    const name = local(e);
    if (SECTIONS.has(name)) {
      this.section(e, out, level, false, depth);
      return true;
    }
    if (CONTAINERS.has(name)) {
      this.blocks(e.children, out, level, depth);
      return true;
    }
    switch (name) {
      case 'para':
      case 'simpara':
        if (attr(e, 'role') === 'rule' && !textContent(e).trim()) out.push({ t: 'rule' });
        else this.paragraph(e, out, level, depth);
        return true;
      case 'formalpara': {
        const title = child(e, 'title');
        if (title) this.para(this.spans(title.children, { bold: true }), out);
        this.blocks(e.children, out, level, depth);
        return true;
      }
      case 'bridgehead':
        this.heading(e, out, level + 1);
        return true;
      case 'itemizedlist':
        this.list(elements(e).filter((c) => local(c) === 'listitem'), false, 1, out, level, depth);
        return true;
      case 'orderedlist':
        this.list(elements(e).filter((c) => local(c) === 'listitem'), true, Math.max(1, Number(attr(e, 'startingnumber')) || 1), out, level, depth);
        return true;
      case 'simplelist':
        this.list(elements(e).filter((c) => local(c) === 'member'), false, 1, out, level, depth, (m) => [para(m.children)]);
        return true;
      case 'procedure':
      case 'substeps':
      case 'stepalternatives':
        this.list(elements(e).filter((c) => local(c) === 'step'), name !== 'stepalternatives', 1, out, level, depth);
        return true;
      case 'calloutlist':
        this.list(elements(e).filter((c) => local(c) === 'callout'), true, 1, out, level, depth);
        return true;
      case 'variablelist':
      case 'glosslist': {
        const [entry, term, body] = name === 'variablelist' ? ['varlistentry', 'term', 'listitem'] : ['glossentry', 'glossterm', 'glossdef'];
        this.list(elements(e).filter((c) => local(c) === entry), false, 1, out, level, depth, (item) => {
          const terms = elements(item).filter((c) => local(c) === term).flatMap((t, i) => (i ? [', ', ...t.children] : t.children));
          return [para(terms), ...elements(item).filter((c) => local(c) === body)];
        });
        return true;
      }
      case 'glossentry': {
        const term = child(e, 'glossterm');
        if (term) this.para(this.spans(term.children, { bold: true }), out);
        for (const def of elements(e).filter((c) => local(c) === 'glossdef')) this.blocks(def.children, out, level, depth);
        return true;
      }
      case 'programlisting':
      case 'screen':
      case 'synopsis':
        this.code(e, out, attr(e, 'language'));
        return true;
      case 'literallayout':
      case 'address':
        this.lines(e, out);
        return true;
      case 'blockquote':
      case 'epigraph':
        this.quote(e, out, level, depth);
        return true;
      case 'table':
      case 'informaltable':
        this.table(e, out, level, depth);
        return true;
      case 'equation':
      case 'informalequation': {
        const tex = this.math(e);
        if (tex) out.push({ t: 'para', spans: [{ text: tex, math: 'display' }] });
        return true;
      }
      case 'biblioentry':
      case 'bibliomixed':
        this.para([{ text: textContent(e) }], out);
        return true;
    }
    // (What is left out, a footnote in a paragraph or a title, is inline: the paragraph around it stays one.)
    if (SKIP.has(name) || isInfo(e)) return false;
    // An element the reader doesn't know that holds blocks is read as the blocks in it.
    if (elements(e).some((c) => BLOCKS.has(local(c)))) {
      this.blocks(e.children, out, level, depth);
      return true;
    }
    return false;
  }

  /** A section: its title a heading one level down, and its content under it. The document's own element has a heading only if it has a title. */
  section(e: XmlElement, out: Node[], level: number, root: boolean, depth = 0): void {
    const title = titleOf(e);
    this.heading(title, out, level + 1);
    this.blocks(e.children, out, root && !title ? level : level + 1, depth);
  }

  /** Text whose line ends are line breaks. */
  private lines(e: XmlElement, out: Node[]): void {
    const spans: Span[] = [];
    for (const s of this.spans(e.children)) {
      if (s.br || s.math) spans.push(s);
      else s.text.split('\n').forEach((line, i) => spans.push(...(i ? [{ text: '', br: true }] : []), { ...s, text: line }));
    }
    const finished = finishSpans(spans);
    if (finished.length) out.push({ t: 'para', spans: finished });
  }
}

export function parseDocbook(source: string): Node[] {
  const root = readXml(source, 'DocBook');
  const reader = new DocbookReader();
  if (SECTIONS.has(local(root))) reader.section(root, reader.out, 0, true);
  else reader.blocks([root], reader.out, 0);
  return reader.out;
}

// --- Writing -------------------------------------------------------------------------------------

const TAGS: MarkTags = {
  link: (s) => [`<link xlink:href="${escapeAttr(s.link!)}">`, '</link>'],
  bold: () => ['<emphasis role="bold">', '</emphasis>'],
  italic: () => ['<emphasis>', '</emphasis>'],
  underline: () => ['<emphasis role="underline">', '</emphasis>'],
  strike: () => ['<emphasis role="strikethrough">', '</emphasis>'],
  sup: () => ['<superscript>', '</superscript>'],
  sub: () => ['<subscript>', '</subscript>'],
  code: () => ['<literal>', '</literal>'],
};

const inline = (spans: readonly Span[]): string =>
  inlineXml(spans, TAGS, {
    // DocBook has no line break inside a paragraph: it is a line end, which reads back as a space.
    br: '\n',
    math: (s) => `<inlineequation><alt role="tex">${escapeText(s.text)}</alt></inlineequation>`,
  });

export function renderDocbook(nodes: readonly Node[]): string {
  const { title, rest } = documentTitle(nodes);
  const tree = sectionTree(rest);
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<article xmlns="http://docbook.org/ns/docbook" xmlns:xlink="http://www.w3.org/1999/xlink" version="5.0">'];
  if (title) out.push(`  <title>${inline(title)}</title>`);
  writeSection(tree, out, '  ');
  out.push('</article>', '');
  return out.join('\n');
}

function writeSection(section: Section, out: string[], indent: string): void {
  for (const node of section.blocks) writeBlock(node, out, indent);
  for (const s of section.sections) {
    out.push(`${indent}<section>`);
    if (s.title) out.push(`${indent}  <title>${inline(s.title)}</title>`);
    writeSection(s, out, indent + '  ');
    out.push(`${indent}</section>`);
  }
}

function writeBlock(node: Node, out: string[], indent: string): void {
  switch (node.t) {
    case 'heading': // (headings are sections; one inside a list item is a bold paragraph)
      out.push(`${indent}<para>${inline(node.spans.map((s) => ({ ...s, bold: true })))}</para>`);
      return;
    case 'para':
      out.push(`${indent}<para>${inline(node.spans)}</para>`);
      return;
    case 'code':
      out.push(`${indent}<programlisting${node.lang ? ` language="${escapeAttr(node.lang)}"` : ''}>${escapeText(node.text)}</programlisting>`);
      return;
    case 'quote':
      out.push(`${indent}<blockquote>`);
      for (const p of node.paras) out.push(`${indent}  <para>${inline(p)}</para>`);
      out.push(`${indent}</blockquote>`);
      return;
    case 'list':
      out.push(node.ordered ? `${indent}<orderedlist${node.start !== 1 ? ` startingnumber="${node.start}"` : ''}>` : `${indent}<itemizedlist>`);
      for (const item of node.items) {
        out.push(`${indent}  <listitem>`, `${indent}    <para>${inline(item.spans)}</para>`);
        for (const c of item.children) writeBlock(c, out, indent + '    ');
        out.push(`${indent}  </listitem>`);
      }
      out.push(node.ordered ? `${indent}</orderedlist>` : `${indent}</itemizedlist>`);
      return;
    case 'table': {
      const columns = node.rows.reduce((m, r) => Math.max(m, r.length), 0);
      const row = (cells: Span[][]) => `${indent}      <row>${cells.map((c) => `<entry>${cell(c)}</entry>`).join('')}</row>`;
      out.push(`${indent}<informaltable>`, `${indent}  <tgroup cols="${columns}">`);
      const body = node.header ? node.rows.slice(1) : node.rows;
      if (node.header && node.rows.length) out.push(`${indent}    <thead>`, row(node.rows[0]), `${indent}    </thead>`);
      if (body.length) out.push(`${indent}    <tbody>`, ...body.map(row), `${indent}    </tbody>`);
      out.push(`${indent}  </tgroup>`, `${indent}</informaltable>`);
      return;
    }
    case 'rule':
      out.push(`${indent}<para role="rule"/>`);
      return;
  }
}

/** A cell's text: lines (what a cell's paragraphs come in as) are paragraphs. */
function cell(spans: readonly Span[]): string {
  if (!spans.some((s) => s.br)) return inline(spans);
  const paras: Span[][] = [[]];
  for (const s of spans) {
    if (s.br) paras.push([]);
    else paras[paras.length - 1].push(s);
  }
  return paras.map((p) => `<para>${inline(p)}</para>`).join('');
}
