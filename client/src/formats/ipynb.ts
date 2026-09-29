// Jupyter notebooks (.ipynb) as documents. A notebook is JSON: a list of cells, each Markdown, code or
// raw text, with the output of running the code. Reading shows the Markdown cells as document text (headings,
// lists, tables, links), code cells as code blocks, and their output under them, in a look of its own:
// text as it was printed, pictures as pictures. Writing makes a notebook again: text between code blocks
// becomes Markdown cells, code blocks become code cells, and the output, run counts and metadata of cells
// whose code wasn't changed come back from the notebook that was opened (kept with the document).

import { WordDocument, paragraphsIn, paragraphText } from '@word/docx';
import { t } from '../i18n/index.ts';
import { sniffImage } from './images.ts';
import { markdownToDocument } from './markdown.ts';
import { documentToOutline, isWord, outlineToDocument, renderSpans } from './outline.ts';
import type { Node, Span, SpanFormat } from './outline.ts';
import type { IpynbExtension } from './wdoc.ts';

interface Cell {
  cell_type?: string;
  source?: string | string[];
  outputs?: Output[];
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
  id?: string;
}

interface Output {
  output_type?: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

const joined = (value: string | string[] | undefined): string => (Array.isArray(value) ? value.join('') : (value ?? ''));
/** Terminal colour codes in error tracebacks. */
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** A notebook's metadata as it should be kept (the parts that are notebook-wide). */
function notebookInfo(json: Record<string, unknown>): IpynbExtension['notebook'] {
  return { metadata: (json.metadata as Record<string, unknown>) ?? {}, nbformat: (json.nbformat as number) ?? 4, nbformat_minor: (json.nbformat_minor as number) ?? 5 };
}

function languageOf(info: IpynbExtension['notebook']): string {
  const meta = info.metadata as { language_info?: { name?: string }; kernelspec?: { language?: string } };
  return (meta.language_info?.name ?? meta.kernelspec?.language ?? 'python').toLowerCase();
}

// --- Reading -------------------------------------------------------------------------------------

const PICTURE_MARK = (n: number): string => `\u2063picture-${n}\u2063`;

/** A notebook as a document, and what is kept of it for writing it back. */
export async function notebookToDocument(source: string): Promise<{ document: WordDocument; extension: IpynbExtension }> {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(source.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(t('app.notNotebook'));
  }
  if (!json || typeof json !== 'object' || !Array.isArray(json.cells)) throw new Error(t('app.notNotebook'));
  const info = notebookInfo(json);
  const language = languageOf(info);
  const nodes: Node[] = [];
  const code: IpynbExtension['code'] = [];
  const pictures: Uint8Array[] = [];
  for (const cell of json.cells as Cell[]) {
    const text = joined(cell.source);
    if (cell.cell_type === 'code') {
      // Adjacent code blocks would run together in the document: an empty paragraph keeps each its own.
      if (nodes.at(-1)?.t === 'code') nodes.push({ t: 'para', spans: [] });
      nodes.push({ t: 'code', text: text.replace(/\n$/, ''), lang: language });
      code.push({ source: text, outputs: cell.outputs ?? [], executionCount: cell.execution_count ?? null, metadata: cell.metadata ?? {} });
      for (const output of cell.outputs ?? []) nodes.push(...outputNodes(output, pictures));
    } else if (text.trim()) {
      if (cell.cell_type === 'raw') nodes.push({ t: 'para', spans: [{ text }] });
      else nodes.push(...documentToOutline(await markdownToDocument(text)));
    }
  }
  const document = await outlineToDocument(nodes);
  placePictures(document, pictures);
  return { document, extension: { notebook: info, code } };
}

function outputNodes(output: Output, pictures: Uint8Array[]): Node[] {
  const nodes: Node[] = [];
  const out = (text: string) => {
    const trimmed = text.replace(/\n+$/, '');
    if (trimmed) nodes.push({ t: 'code', text: trimmed, lang: 'output' });
  };
  if (output.output_type === 'stream') out(joined(output.text));
  else if (output.output_type === 'error') out([`${output.ename ?? 'Error'}: ${output.evalue ?? ''}`, ...(output.traceback ?? [])].join('\n').replace(ANSI, ''));
  else if (output.data) {
    const image = ['image/png', 'image/jpeg', 'image/webp'].find((type) => output.data![type]);
    if (image) {
      try {
        const bytes = Uint8Array.from(atob(joined(output.data[image]).replace(/\s/g, '')), (c) => c.charCodeAt(0));
        if (sniffImage(bytes)) {
          nodes.push({ t: 'para', spans: [{ text: PICTURE_MARK(pictures.length) }] });
          pictures.push(bytes);
          return nodes;
        }
      } catch {
        // Not a picture after all: its text below, if it has any.
      }
    }
    const plainText = joined(output.data['text/plain']);
    if (plainText) out(plainText);
    else if (output.data['text/html']) out(joined(output.data['text/html']).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim());
  }
  return nodes;
}

/** Puts each output picture where its marker paragraph is: an inline picture at most 6.5 inches wide. */
function placePictures(doc: WordDocument, pictures: Uint8Array[]): void {
  if (!pictures.length) return;
  for (const p of paragraphsIn(doc.body)) {
    const m = /^\u2063picture-(\d+)\u2063$/.exec(paragraphText(p));
    if (!m) continue;
    const bytes = pictures[Number(m[1])];
    const image = sniffImage(bytes)!;
    const scale = Math.min(1, 624 / Math.max(image.width, 1));
    const part = doc.addImage(bytes, image.type);
    p.children = [{ kind: 'run', properties: {}, content: [{ kind: 'drawing', inline: true, width: Math.round(image.width * scale * 9525), height: Math.round(image.height * scale * 9525), image: part }], attrs: {} }];
  }
}

// --- Writing -------------------------------------------------------------------------------------

/** Text as Markdown: the spans with * _ ` ~~ and links, escaped where it would otherwise mean something. */
const markdown: SpanFormat = {
  br: '  \n',
  text: (s, code) => (code ? s : s.replace(/([\\`*_[\]<])/g, '\\$1').replace(/&(?=[a-z#])/gi, '\\&')),
  mark(kind, inner, before, after) {
    switch (kind) {
      case 'bold':
        return `**${inner}**`;
      case 'italic':
        return isWord(before.slice(-1)) || isWord(after[0]) ? `<em>${inner}</em>` : `*${inner}*`;
      case 'code': {
        const ticks = '`'.repeat(Math.max(1, ...[...inner.matchAll(/`+/g)].map((m) => m[0].length + 1)));
        return `${ticks}${inner.startsWith('`') || inner.endsWith('`') ? ` ${inner} ` : inner}${ticks}`;
      }
      case 'strike':
        return `~~${inner}~~`;
      case 'underline':
        return `<u>${inner}</u>`;
      case 'sup':
        return `<sup>${inner}</sup>`;
      case 'sub':
        return `<sub>${inner}</sub>`;
    }
  },
  link: (url, inner) => `[${inner}](${/[\s()]/.test(url) ? `<${url}>` : url})`,
};

const inline = (spans: Span[]): string => renderSpans(spans, markdown);

/** A line that would begin a heading, list, quote or rule is escaped at its first character. */
const guard = (text: string): string => text.replace(/^(\s*)([#>+-]|\d+[.)])(?=\s|$)/gm, '$1\\$2');

function renderMarkdown(nodes: readonly Node[]): string {
  return nodes.map((n) => markdownBlock(n, 0)).filter(Boolean).join('\n\n');
}

function markdownBlock(node: Node, depth: number): string {
  const indent = '    '.repeat(depth);
  switch (node.t) {
    case 'heading':
      return `${'#'.repeat(Math.min(node.level, 6))} ${inline(node.spans).replace(/\s*\n\s*/g, ' ')}`;
    case 'para':
      return guard(inline(node.spans));
    case 'rule':
      return '---';
    case 'code':
      return `\`\`\`\n${node.text}\n\`\`\``;
    case 'quote':
      return node.paras.map((p) => guard(inline(p)).split('\n').map((l) => `> ${l}`).join('\n')).join('\n>\n');
    case 'list': {
      const lines: string[] = [];
      node.items.forEach((item, k) => {
        const marker = node.ordered ? `${node.start + k}. ` : '- ';
        lines.push(`${indent}${marker}${inline(item.spans).replace(/\n/g, ' ')}`);
        for (const child of item.children) lines.push(child.t === 'list' ? markdownBlock(child, depth + 1) : `\n${markdownBlock(child, depth + 1).split('\n').map((l) => `${indent}    ${l}`).join('\n')}\n`);
      });
      return lines.join('\n');
    }
    case 'table': {
      const cell = (spans: Span[]) => inline(spans).replace(/\n/g, ' ').replace(/\|/g, '\\|');
      const [head, ...rest] = node.rows;
      const rows = [head, ...rest];
      return [`| ${head.map(cell).join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
    }
  }
}

const lines = (text: string): string[] => text.split('\n').map((l, i, all) => (i < all.length - 1 ? `${l}\n` : l));

/** A document as a notebook: a Markdown cell for each run of text, a code cell for each code block. */
export function documentToNotebook(doc: WordDocument, ext: IpynbExtension | undefined): string {
  const nodes = documentToOutline(doc);
  const info = ext?.notebook ?? { metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 };
  const cells: Record<string, unknown>[] = [];
  let pending: Node[] = [];
  let codeIndex = 0;
  const id = () => `cell-${cells.length + 1}`;
  const flush = () => {
    if (!pending.length) return;
    const text = renderMarkdown(pending);
    pending = [];
    if (text.trim()) cells.push({ cell_type: 'markdown', ...(info.nbformat_minor >= 5 && { id: id() }), metadata: {}, source: lines(text) });
  };
  for (const node of nodes) {
    if (node.t !== 'code') pending.push(node);
    // Output is regenerated from the notebook that was opened, so the copy in the document is not a cell.
    else if (node.lang !== 'output') {
      flush();
      const kept = ext?.code[codeIndex++];
      // Output and run counts belong to the code that produced them: changed code starts without.
      const same = kept && kept.source.replace(/\n$/, '') === node.text;
      cells.push({ cell_type: 'code', ...(info.nbformat_minor >= 5 && { id: id() }), execution_count: same ? kept.executionCount : null, metadata: same ? kept.metadata : {}, outputs: same ? kept.outputs : [], source: lines(node.text) });
    }
  }
  flush();
  return `${JSON.stringify({ cells, metadata: info.metadata, nbformat: info.nbformat, nbformat_minor: info.nbformat_minor }, null, 1)}\n`;
}
