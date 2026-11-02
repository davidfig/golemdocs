import type { Plugin } from 'vite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderAll, renderDocPage, serve as serveHome } from './home/build.ts';

const WELCOME = path.resolve(import.meta.dirname, 'src/layout/welcome/en.md');
const SITE = path.resolve(import.meta.dirname, 'site');
/** The built-in legal documents (`src/layout/legal/<name>/en.md`), each written as its own plain HTML page (`/home/privacy`, `/home/terms`) that never loads the editor. */
const LEGAL_PAGES = [
  { name: 'privacy', description: 'What Golem Docs collects, why, and what it does with it.' },
  { name: 'terms', description: 'The terms for using Golem Docs.' },
];
/**
 * The feature pages of the marketing site (`site/<name>.md`, served at `/home/<name>`). `label` and `blurb` are the name and line shown where a page
 * is linked from another; the Formats page (`home/pages/formats.html`) links the main ones by hand.
 */
const FEATURE_PAGES = [
  { name: 'convert', label: 'Convert formats', blurb: 'Switch a document between 20+ formats, and back again.', description: 'Convert Word, PDF, Markdown, HTML, OpenDocument, EPUB, CSV, LaTeX and more in your browser. Change a document\u2019s format and keep working, with nothing uploaded.' },
  { name: 'pdf', label: 'Edit PDFs', blurb: 'Fill in forms, mark up, edit text, redact, and rearrange pages.', description: 'Edit PDFs in your browser: change text where it sits, fill in forms, highlight and comment, redact private details, and rearrange pages. Free, with nothing uploaded.' },
  { name: 'images', label: 'Edit pictures', blurb: 'Crop, correct, annotate, and redact PNG, JPEG, and WebP.', description: 'Edit pictures in your browser: crop, resize, adjust colors, draw arrows and text, and pixelate private details in PNG, JPEG, and WebP images.' },
  { name: 'vector', label: 'Edit vector drawings', blurb: 'Draw and edit SVG: shapes, pen paths, gradients, brush strokes, and layers.', description: 'Edit SVG vector drawings in your browser: draw shapes and paths, add gradients and brush strokes, work in layers, combine shapes, and convert to PDF, PNG, or Word. Nothing is uploaded.' },
  { name: 'documents', label: 'Word documents', blurb: 'A real word processor for .docx, with tables, columns, and equations.', description: 'Write and edit Word documents in your browser: true page layout, tables, columns, comments, LaTeX equations, and spelling and grammar checking.' },
  { name: 'collaborate', label: 'Work together', blurb: 'Share a link and edit together, live.', description: 'Share a document and edit it together in real time, with names and cursors. Sharing is part of the subscription; editing and downloading are free and never need an account.' },
  { name: 'customize', label: 'Make it yours', blurb: 'Word 2003 menus, five color schemes, dark mode, and 11 languages.', description: 'A Word 2003-style editor you can make your own: color schemes, dark mode, customizable toolbars, and 11 languages.' },
  { name: 'import', label: 'Import files and folders', blurb: 'Bring in files, whole folders, and ZIP archives, keeping their folders.', description: 'Import files, folders, and ZIP archives into Golem Docs. Documents land in the same folders they came from, names never collide, and nothing is uploaded.' },
  { name: 'obsidian', label: 'Import an Obsidian vault', blurb: 'Move your notes from Obsidian, folders and all.', description: 'Import an Obsidian vault into Golem Docs as a folder or ZIP: your notes arrive in their folders, with properties kept and nothing uploaded.' },
  { name: 'pdf-to-word', label: 'PDF to Word', blurb: 'Turn a PDF into an editable Word file without uploading it.', description: 'Convert a PDF to an editable Word document in your browser. Text, pictures, vector drawings, headers and footers come across, and the file is never uploaded.' },
  { name: 'markdown-to-word', label: 'Markdown to Word', blurb: 'Convert notes to Word, HTML, or PDF, and back.', description: 'Convert Markdown to Word, HTML, or PDF and back in your browser, with headings, lists, tables, links, math, and Obsidian links carried across. Nothing is uploaded.' },
  { name: 'redact-pdf', label: 'Redact a PDF', blurb: 'Black out private text so it cannot be copied out.', description: 'Redact a PDF in your browser: black out private details and remove the text under the box from the file. Free, with no account and nothing uploaded.' },
  { name: 'open-docx-online', label: 'Open Word files online', blurb: 'Edit a .docx without Word, with nothing to install.', description: 'Open and edit .docx Word documents in your browser with true page layout, tables, comments and equations. Free, with no account and nothing to install.' },
  { name: 'large-files', label: 'Huge text files', blurb: 'Open, search, edit, and replace in 50 MB log files without freezing.', description: 'Open text and log files of 50 MB and more in your browser, then scroll, search, filter, edit, replace, and copy without freezing.' },
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

interface SitePage {
  /** The path under `/home`. */
  name: string;
  description: string;
  md: string;
  /** A feature page ends with a call to open the app and links to the other feature pages; a legal page doesn't. */
  feature: boolean;
}

/**
 * A page of the marketing site under `/home` that is English prose: the site's frame (home/build.ts) around the Markdown text
 * of a legal document or feature page. Documents link the app's own paths (`/terms`); here those links go to the sibling pages.
 */
function sitePage({ name, description, md, feature }: SitePage): string {
  const heading = /^#\s+(.*)$/m.exec(md)?.[1] ?? name;
  const extras = feature
    ? `\n<p class="try"><a class="btn primary big" href="/">Open Golem Docs</a></p>\n<div class="more">\n<h2>More you can do</h2>\n<ul class="guides">\n${FEATURE_PAGES.filter((f) => f.name !== name)
        .map((f) => `<li><a href="/home/${f.name}"><b>${escapeHtml(f.label)}</b><span>${escapeHtml(f.blurb)}</span></a></li>`)
        .join('\n')}\n</ul>\n</div>`
    : '';
  const figures = feature ? `<style>\n${readFileSync(path.join(SITE, 'figures.css'), 'utf8')}</style>\n` : '';
  return renderDocPage({
    path: `/home/${name}`,
    title: feature ? `${heading} | Golem Docs` : heading,
    description,
    heading,
    body: `${figures}${withFigure(markdownToHtml(md), name)}${extras}`,
  });
}

/**
 * A feature page's illustration (`site/<name>.figure.html`, drawn in HTML and CSS, styled by `site/figures.css`) goes after the
 * page's first paragraph, its introduction. A screenshot (`site/<name>.shot.html`) goes where the page's text has a `{{shot}}` paragraph.
 */
function withFigure(html: string, name: string): string {
  const file = path.join(SITE, `${name}.figure.html`);
  const shot = path.join(SITE, `${name}.shot.html`);
  if (existsSync(shot)) html = html.replace('<p>{{shot}}</p>', () => readFileSync(shot, 'utf8'));
  return existsSync(file) ? html.replace('</p>', () => `</p>\n${readFileSync(file, 'utf8')}`) : html;
}

/** The source of a feature page. */
const featureSource = (name: string): string => readFileSync(path.join(SITE, `${name}.md`), 'utf8');
/** Every page under `/home` other than the home page itself, by path. */
function sitePages(): SitePage[] {
  return [
    ...FEATURE_PAGES.map(({ name, description }) => ({ name, description, md: featureSource(name), feature: true })),
    ...LEGAL_PAGES.map(({ name, description }) => ({
      name,
      description,
      md: readFileSync(path.resolve(import.meta.dirname, `src/layout/legal/${name}/en.md`), 'utf8').replace(/\]\(\/(privacy|terms)\)/g, '](/home/$1)'),
      feature: false,
    })),
  ];
}

/**
 * Replaces `<!--welcome-->` in index.html with the welcome document as plain HTML. The editor draws
 * to a canvas, so without this a crawler (or a browser with scripts off) finds no text to read.
 * After the build, plain pages without the editor are written under `home/` (`home/pdf.html`, `home/privacy.html`...), served
 * at `/home/pdf`, `/home/privacy` and so on beside the site's own pages (home/build.ts, every language).
 * (`/privacy` and `/terms` are the app's own addresses for the same documents, opened in the editor.)
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
    // In production these addresses are files or redirects (public/_redirects); the dev server answers every unknown path
    // with the editor, so it does the same here: /home, /home/<page> and /home/<lang>/<page> are the site's pages (home/build.ts), /home/<guide> the guides and
    // legal pages, and the old /privacy and /terms redirect to them.
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        const old = LEGAL_PAGES.find(({ name }) => url === `/${name}` || url === `/${name}.html`);
        if (old) {
          res.statusCode = 301;
          res.setHeader('location', `/home/${old.name}`);
          return void res.end();
        }
        try {
          // The site's own pages, in every language, rendered from home/ on each request.
          const home = serveHome(url);
          if (home) {
            res.setHeader('content-type', 'text/html; charset=utf-8');
            return void res.end(home);
          }
          const page = sitePages().find(({ name }) => url === `/home/${name}` || url === `/home/${name}.html` || url === `/home/${name}/`);
          if (!page) return next();
          res.setHeader('content-type', 'text/html');
          res.end(sitePage(page));
        } catch (error) {
          next(error);
        }
      });
    },
    closeBundle() {
      if (!existsSync(path.join(outDir, 'index.html'))) return; // not a full build
      mkdirSync(path.join(outDir, 'home'), { recursive: true });
      for (const [file, html] of renderAll()) {
        mkdirSync(path.dirname(path.join(outDir, file)), { recursive: true });
        writeFileSync(path.join(outDir, file), html);
      }
      for (const page of sitePages()) writeFileSync(path.join(outDir, 'home', `${page.name}.html`), sitePage(page));
    },
  };
}
