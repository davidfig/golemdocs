import type { Plugin } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WELCOME = path.resolve(import.meta.dirname, 'src/layout/welcome/en.md');
/** The built-in legal documents, each written as its own plain HTML page (`/privacy`, `/terms`) that never loads the editor. */
const LEGAL_PAGES = [
  { name: 'privacy', description: 'What Golem Docs collects, why, and what it does with it.' },
  { name: 'terms', description: 'The terms for using Golem Docs.' },
];

/** The app's icon before the first heading (the title), as the app draws it: 24 pt, level with the letters. */
const withIcon = (html: string): string => html.replace('<h1>', '<h1><img class="icon" src="/favicon.svg" alt="" width="32" height="32"> ');

/**
 * The app's Calibri (Carlito) for the plain legal pages, so they match the canvas. A page that declares these fetches
 * a face only when its text uses it.
 */
const FONT_CSS = `<style>${[
  ['regular', 'normal', 400],
  ['bold', 'normal', 700],
  ['italic', 'italic', 400],
  ['bold-italic', 'italic', 700],
]
  .map(([file, style, weight]) => `@font-face{font-family:Carlito;font-style:${style};font-weight:${weight};font-display:swap;src:url(/fonts/calibri/${file}.ttf) format('truetype')}`)
  .join('')}</style>`;
const withFonts = (html: string): string => html.replace('</head>', () => `${FONT_CSS}\n  </head>`);

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
 * A page laid out like the editor's own: a white sheet on the gray desk, Letter width with 1 in margins, Calibri 11 pt,
 * shrunk to fit a narrow window (`--s` is one sheet pixel). No toolbars, no scripts.
 */
const PLAIN_CSS = `<style>
      html { background: #e5e5e5; }
      html[data-theme='dark'] { background: #1c1d20; }
      body { margin: 0; }
      #seo { --s: min(1px, calc((100vw - 26px) / 816)); position: static; width: auto; height: auto; margin: 0; overflow: visible; clip-path: none; white-space: normal; padding: 24px 13px; font-family: Carlito, Calibri, 'Segoe UI', system-ui, sans-serif; }
      #seo .open { width: calc(816 * var(--s)); margin: 0 auto 12px; font-size: 14px; }
      #seo .open a { color: #2f5496; text-decoration: none; }
      #seo > .page { box-sizing: border-box; width: calc(816 * var(--s)); margin: 0 auto; padding: calc(96 * var(--s)); min-height: calc(1056 * var(--s)); background: #fff; color: #000; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35), 0 0 14px rgba(0, 0, 0, 0.12); font-size: calc(14.667 * var(--s)); line-height: 1.316; }
      #seo p { margin: 0 0 0.73em; }
      #seo h1, #seo h2, #seo h3 { font-weight: 400; color: #2f5496; }
      #seo h1 { margin: 0.43em 0; font-size: 2.545em; line-height: 1.2; }
      #seo h1 .icon { height: 0.857em; width: 0.857em; vertical-align: -0.107em; margin-right: 0.15em; }
      #seo h2 { margin: 0.2em 0 0; font-size: 1.18em; }
      #seo h3 { margin: 0.2em 0 0; font-size: 1.09em; color: #1f3763; }
      #seo ul, #seo ol { margin: 0 0 0.73em; padding-left: 3.27em; }
      #seo code { font-family: 'Courier New', monospace; background: #f2f2f2; }
      html[data-theme='dark'] #seo > .page { background: #2a2b30; color: #e5e5e5; }
      html[data-theme='dark'] #seo h1, html[data-theme='dark'] #seo h2, html[data-theme='dark'] #seo h3, html[data-theme='dark'] #seo a { color: #8ab4f8; }
      html[data-theme='dark'] #seo code { background: #1c1d20; }
    </style>`;

interface PlainPage {
  md: string;
  title: string;
  description: string;
  url: string;
}

/**
 * The built index.html turned into a page of plain HTML: the text of `md` as a sheet, and none of the editor (no
 * scripts, styles, toolbars or canvas), so nothing is drawn twice and nothing loads that the text doesn't need.
 */
export function plainPage(index: string, { md, title, description, url }: PlainPage): string {
  const meta = (attr: string, name: string, value: string): ((s: string) => string) => (s) =>
    s.replace(new RegExp(`(<meta ${attr}="${name}" content=")[^"]*"`), (_, head: string) => `${head}${escapeHtml(value)}"`);
  let page = index
    .replace(/<script type="module"[^>]*><\/script>\s*/g, '')
    .replace(/<link rel="(?:modulepreload|stylesheet)"[^>]*>\s*/g, '')
    .replace(/<header id="chrome"><\/header>\s*/, '')
    .replace(/<main id="viewport">[\s\S]*?<\/main>\s*/, '')
    .replace(/<div id="debug">[\s\S]*?<\/div>\s*(?=<\/body>)/, '')
    .replace(/<aside id="intro"[\s\S]*?<\/aside>\s*/, '')
    .replace(/<script>\s*\(function \(\) \{\s*var intro[\s\S]*?<\/script>\s*/, '')
    .replace(/<noscript>[\s\S]*?<\/noscript>\s*/, '')
    .replace(/<title>.*?<\/title>/, () => `<title>${escapeHtml(title)}</title>`)
    .replace(/(<link rel="canonical" href=")[^"]*"/, (_, head: string) => `${head}${url}"`)
    .replace(/(<meta property="og:url" content=")[^"]*"/, (_, head: string) => `${head}${url}"`)
    .replace(/(<article id="seo">)[\s\S]*?(<\/article>)/, (_, open: string, close: string) => `${open}\n<p class="open"><a href="/">Open Golem Docs</a></p>\n<div class="page">\n${withIcon(markdownToHtml(md))}\n</div>\n    ${close}`)
    .replace('</head>', () => `${PLAIN_CSS}\n  </head>`);
  page = meta('name', 'description', description)(page);
  page = meta('property', 'og:description', description)(page);
  page = meta('property', 'og:title', title)(page);
  return withFonts(page);
}

/** A legal document (`src/layout/legal/<name>/en.md`) as a plain page. */
function legalPage(index: string, name: string, description: string): string {
  const md = readFileSync(path.resolve(import.meta.dirname, `src/layout/legal/${name}/en.md`), 'utf8');
  const title = /^#\s+(.*)$/m.exec(md)?.[1] ?? name;
  return plainPage(index, { md, title, description, url: `https://golemdocs.com/${name}` });
}

/**
 * Replaces `<!--welcome-->` in index.html with the welcome document as plain HTML. The editor draws
 * to a canvas, so without this a crawler (or a browser with scripts off) finds no text to read.
 * After the build, plain pages without the editor are written next to it: `privacy.html` and `terms.html`,
 * served at `/privacy` and `/terms`.
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
    // The dev server answers every path with the editor, so the plain pages are at /privacy.html and /terms.html here
    // (in production `/privacy` and `/terms` are these pages).
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const page = LEGAL_PAGES.find(({ name }) => req.url?.split('?')[0] === `/${name}.html`);
        if (!page) return next();
        try {
          const index = await server.transformIndexHtml('/', readFileSync(path.resolve(import.meta.dirname, 'index.html'), 'utf8'));
          res.setHeader('content-type', 'text/html');
          res.end(legalPage(index, page.name, page.description));
        } catch (error) {
          next(error);
        }
      });
    },
    closeBundle() {
      let index: string;
      try {
        index = readFileSync(path.join(outDir, 'index.html'), 'utf8');
      } catch {
        return; // not a full build
      }
      for (const { name, description } of LEGAL_PAGES) writeFileSync(path.join(outDir, `${name}.html`), legalPage(index, name, description));
    },
  };
}
