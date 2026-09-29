import type { Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const WELCOME = path.resolve(import.meta.dirname, 'src/layout/welcome/en.md');

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline markup: `code`, **bold**, *italic* and [links](url). */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/** The small subset of Markdown the welcome document uses: headings, paragraphs and lists. */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const flush = (): void => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = (): void => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const line of md.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*(?:([-*])|\d+\.)\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      closeList();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    } else if (item) {
      flush();
      const kind = item[1] ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline(item[2])}</li>`);
    } else if (!line.trim()) {
      flush();
      closeList();
    } else {
      closeList();
      paragraph.push(line.trim());
    }
  }
  flush();
  closeList();
  return out.join('\n');
}

/**
 * Replaces `<!--welcome-->` in index.html with the welcome document as plain HTML. The editor draws
 * to a canvas, so without this a crawler (or a browser with scripts off) finds no text to read.
 */
export function welcomeContent(): Plugin {
  return {
    name: 'welcome-content',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replace('<!--welcome-->', () => markdownToHtml(readFileSync(WELCOME, 'utf8'))),
    },
  };
}
