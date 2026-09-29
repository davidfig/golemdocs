import type { Plugin } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WELCOME = path.resolve(import.meta.dirname, 'src/layout/welcome/en.md');
/** The built-in legal documents, each also written as its own static page (`/privacy`, `/terms`) for crawlers. */
const LEGAL_PAGES = [
  { name: 'privacy', description: 'What Golem Docs collects, why, and what it does with it.' },
  { name: 'terms', description: 'The terms for using Golem Docs.' },
];

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
 * After the build, the same page is written again as `privacy.html` and `terms.html` with the
 * policy in place of the welcome text: the host serves them at `/privacy` and `/terms`, where the app
 * opens the matching document.
 */
export function welcomeContent(): Plugin {
  let outDir = '';
  return {
    name: 'welcome-content',
    configResolved: (config) => {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replace('<!--welcome-->', () => markdownToHtml(readFileSync(WELCOME, 'utf8'))),
    },
    closeBundle() {
      const indexPath = path.join(outDir, 'index.html');
      let index: string;
      try {
        index = readFileSync(indexPath, 'utf8');
      } catch {
        return; // not a full build
      }
      for (const { name, description } of LEGAL_PAGES) {
        const md = readFileSync(path.resolve(import.meta.dirname, `src/layout/legal/${name}/en.md`), 'utf8');
        const title = `${/^#\s+(.*)$/m.exec(md)?.[1] ?? name} | Golem Docs`;
        const url = `https://golemdocs.com/${name}`;
        const page = index
          .replace(/<title>.*?<\/title>/, () => `<title>${escapeHtml(title)}</title>`)
          .replace(/(<meta name="description" content=")[^"]*"/, (_, head: string) => `${head}${escapeHtml(description)}"`)
          .replace(/(<meta property="og:description" content=")[^"]*"/, (_, head: string) => `${head}${escapeHtml(description)}"`)
          .replace(/(<meta property="og:title" content=")[^"]*"/, (_, head: string) => `${head}${escapeHtml(title)}"`)
          .replace(/(<meta property="og:url" content=")[^"]*"/, (_, head: string) => `${head}${url}"`)
          .replace(/(<link rel="canonical" href=")[^"]*"/, (_, head: string) => `${head}${url}"`)
          .replace(/(<article id="seo">)[\s\S]*?(<\/article>)/, (_, open: string, close: string) => `${open}\n${markdownToHtml(md)}\n      <p><a href="/">Golem Docs</a></p>\n    ${close}`);
        writeFileSync(path.join(outDir, `${name}.html`), page);
      }
    },
  };
}
