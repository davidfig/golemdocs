// What a page's `<golem-embed src="…">` shows (docs/html-pages.md §3): a live block's result, made HTML. A table is a table, a
// value its text, part of a text document its blocks as the HTML writer writes them (with the document's styles), a picture
// an <img> (or a drawing's SVG, inline). An error says why, in place.

import type { WordDocument } from '@golemdocs/docx';
import { documentToHtml } from '../formats/html.ts';
import { sniffImage } from '../formats/images.ts';
import type { ImageData } from '../formats/images.ts';
import type { LiveResult } from '../live/result.ts';
import { dataUrl, escapeHtml } from './compose.ts';

const cellHtml = (text: string): string => escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');

/** A table result as an HTML table, its header row in <thead>. */
export function tableHtml(result: Extract<LiveResult, { kind: 'table' }>): string {
  const rows = result.rows.map((cells, r) => {
    const tag = result.header && r === 0 ? 'th' : 'td';
    return `<tr>${cells.map((c, i) => `<${tag}${result.align[i] && result.align[i] !== 'left' ? ` style="text-align:${result.align[i]}"` : ''}>${cellHtml(c)}</${tag}>`).join('')}</tr>`;
  });
  const head = result.header && rows.length ? `<thead>${rows[0]}</thead>` : '';
  return `<table>${head}<tbody>${rows.slice(result.header ? 1 : 0).join('')}</tbody></table>`;
}

/**
 * A style sheet with every rule limited to what is inside a `golem-embed` (`body` and `html` become the embed itself). Rules inside
 * an at-rule (`@media`) are dropped: the writer makes none, and a rule left unscoped would restyle the whole page.
 */
export function scopeCss(css: string): string {
  const out: string[] = [];
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  for (const m of flat.matchAll(/([^{}]*)\{([^{}]*)\}|([^{}]*)\{|\}/g)) {
    if (m[3] !== undefined) depth++;
    else if (m[0] === '}' && m[1] === undefined) depth = Math.max(0, depth - 1);
    else if (depth === 0 && m[1] !== undefined && !m[1].trim().startsWith('@')) {
      const selectors = m[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (/^(html|body|:root)$/i.test(s) ? 'golem-embed' : `golem-embed ${s.replace(/^(html|body)\s+/i, '')}`));
      if (selectors.length) out.push(`${selectors.join(', ')} {${m[2]}}`);
    }
  }
  return out.join('\n');
}

/** Part of a text document as HTML: its blocks written by the HTML writer, with the document's paragraph styles. */
export function blocksHtml(result: Extract<LiveResult, { kind: 'blocks' }>): string {
  const doc = Object.assign(Object.create(Object.getPrototypeOf(result.from) as object) as WordDocument, result.from, { body: result.blocks });
  const images = new Map<string, ImageData>();
  for (const [part, bytes] of Object.entries(result.pictures)) {
    const image = sniffImage(bytes);
    if (image) images.set(part, image);
  }
  const page = documentToHtml(doc, undefined, { images });
  // The document's styles apply to the embed only, never to the page around it.
  const styles = [...page.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => `<style>${scopeCss(m[1])}</style>`).join('');
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(page)?.[1] ?? page;
  return styles + body.trim();
}

/** What an embed shows for a result; `say` gives an error's words in the person's language. */
export function resultHtml(result: LiveResult, say: (result: Extract<LiveResult, { kind: 'error' }>) => string): string {
  switch (result.kind) {
    case 'table':
      return tableHtml(result);
    case 'value':
      return escapeHtml(result.text);
    case 'blocks':
      return blocksHtml(result);
    case 'picture': {
      if (result.svg) return result.svg.replace(/^\s*<\?xml[^>]*>\s*/, '');
      const image = sniffImage(result.bytes);
      return `<img src="${dataUrl(result.bytes, image ? `image/${image.type}` : 'image/png')}" width="${result.width}" height="${result.height}" alt="">`;
    }
    case 'error':
      return `<span class="golem-embed-error" role="note">${escapeHtml(say(result))}</span>`;
  }
}
