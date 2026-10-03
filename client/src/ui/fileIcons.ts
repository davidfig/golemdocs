// A small picture for each kind of file, shown before a document's name (the Documents screen and the
// files sidebar). Saved documents keep the extension of the format they are edited as ("Report.md"),
// so the kind comes from the name. Drawn like the toolbar icons (icons.ts): ink outlines, flat fills.

import { isTextName } from '../formats/textFiles.ts';

export type FileKind = 'doc' | 'md' | 'txt' | 'code' | 'pdf' | 'html' | 'epub' | 'sheet' | 'tex' | 'markup' | 'eml' | 'notebook' | 'image' | 'vector';

const BY_EXTENSION: Record<string, FileKind> = {
  md: 'md', markdown: 'md',
  txt: 'txt', 'text': 'txt', log: 'txt', nfo: 'txt',
  pdf: 'pdf',
  html: 'html', htm: 'html', xhtml: 'html', mhtml: 'html', mht: 'html',
  epub: 'epub',
  csv: 'sheet', tsv: 'sheet', tab: 'sheet',
  tex: 'tex', latex: 'tex',
  adoc: 'markup', asciidoc: 'markup', asc: 'markup', rst: 'markup', rest: 'markup', org: 'markup', wiki: 'markup', mediawiki: 'markup', textile: 'markup',
  eml: 'eml',
  ipynb: 'notebook',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image',
  svg: 'vector', svgz: 'vector',
};

/** Which kind of file a name is. Word-processor formats, and names with no extension, are plain documents. */
export function fileKind(name: string): FileKind {
  const ext = /\.([A-Za-z0-9_+-]{1,12})$/.exec(name)?.[1]?.toLowerCase();
  if (!ext) return 'doc';
  return BY_EXTENSION[ext] ?? (isTextName(name) ? 'code' : 'doc');
}

const INK = '#2e3148';
const WHITE = '#ffffff';
const SKY = '#cfe0ff';
const MIST = '#e8ecf3';
const LINE = '#a3abbf';

const PAGE = 'M3.5 1.5h6l3.5 3.5v9a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1z';
const FOLD = 'M9.5 1.5v2.8a.7.7 0 0 0 .7.7h2.8';

/** The page's fill and the strokes drawn on it. */
const DRAWINGS: Record<FileKind, { fill: string; body: string }> = {
  doc: { fill: '#5b8def', body: `<path d="M5.5 7.5h5M5.5 9.5h5M5.5 11.5h3" stroke="${WHITE}"/>` },
  md: { fill: MIST, body: `<path d="M5 12V8l1.5 2L8 8v4M10.5 8v3.5m-1-1l1 1 1-1" stroke="${INK}" stroke-width="1.1"/>` },
  txt: { fill: WHITE, body: `<path d="M5.5 7.5h5M5.5 9.5h5M5.5 11.5h3" stroke="${LINE}"/>` },
  code: { fill: MIST, body: `<path d="M5.5 7.5l2 2-2 2M8.5 12h2.5" stroke="#9b7bf7" stroke-width="1.4"/>` },
  pdf: { fill: '#ff6b6b', body: `<path d="M5.5 12.5v-5h2a1.4 1.4 0 0 1 0 2.8h-2" stroke="${WHITE}" stroke-width="1.3"/><path d="M10 8.2v4" stroke="${WHITE}" stroke-width="1.3"/>` },
  html: { fill: '#f5a623', body: `<path d="M7 7.5l-2 2 2 2M9.5 7.5l2 2-2 2" stroke="${WHITE}" stroke-width="1.3"/>` },
  epub: { fill: '#9b7bf7', body: `<path d="M8 8.2v4M8 8.2c-.8-.9-2-1-2.6-.8v4c.6-.2 1.8-.1 2.6.8M8 8.2c.8-.9 2-1 2.6-.8v4c-.6-.2-1.8-.1-2.6.8" stroke="${WHITE}" stroke-width="1"/>` },
  sheet: { fill: '#4cc38a', body: `<path d="M5 8h6M5 10.2h6M5 12.4h6M8 7v6" stroke="${WHITE}" stroke-width="1"/>` },
  tex: { fill: '#2fb5b5', body: `<path d="M10.5 7.5h-5l2.5 2.5-2.5 2.5h5" stroke="${WHITE}" stroke-width="1.3"/>` },
  markup: { fill: '#ffc93c', body: `<path d="M6.5 7v5.5M9.5 7v5.5M5 8.6h6M5 10.9h6" stroke="${INK}" stroke-width="1.1"/>` },
  eml: { fill: '#ff8fab', body: `<rect x="4.5" y="7.5" width="7" height="5" rx=".8" fill="${WHITE}" stroke-width="1"/><path d="M4.8 8l3.2 2.5L11.2 8" stroke-width="1"/>` },
  notebook: { fill: '#f5a623', body: `<path d="M6.5 7.5h4M6.5 9.5h4M6.5 11.5h4" stroke="${WHITE}"/><path d="M5 7.5v0M5 9.5v0M5 11.5v0" stroke="${WHITE}" stroke-width="1.6"/>` },
  vector: { fill: '#e6dcff', body: `<path d="M5 12.6C5.6 8.6 8.6 11.8 11 7.6" stroke="#7a52e0" stroke-width="1.2"/><rect x="3.9" y="11.5" width="2.2" height="2.2" rx=".4" fill="${WHITE}" stroke-width=".9"/><rect x="9.9" y="6.5" width="2.2" height="2.2" rx=".4" fill="${WHITE}" stroke-width=".9"/>` },
  image: { fill: SKY, body: `<circle cx="10.3" cy="8" r="1" fill="#ffc93c" stroke-width=".8"/><path d="M4.8 12.5l2.4-3 1.8 2 1.2-1.3 1.3 2.3z" fill="#4cc38a" stroke-width="1"/>` },
};

/** The icon's SVG for a kind, 16px. */
export function fileIconSvg(kind: FileKind): string {
  const { fill, body } = DRAWINGS[kind];
  return (
    `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="${INK}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="${PAGE}" fill="${fill}"/><path d="${FOLD}" fill="${SKY}"/>${body}</svg>`
  );
}

/** An icon element for a file name, to put before it. */
export function fileIcon(name: string): HTMLSpanElement {
  const kind = fileKind(name);
  const el = document.createElement('span');
  el.className = 'wm-file-icon';
  el.dataset.kind = kind;
  el.innerHTML = fileIconSvg(kind);
  return el;
}

/** A name split into its stem and its ".extension" ('' when it has none, or is all extension like ".gitignore"). */
export function splitExtension(name: string): [string, string] {
  const at = name.search(/\.[A-Za-z0-9_+-]{1,12}$/);
  return at > 0 ? [name.slice(0, at), name.slice(at)] : [name, ''];
}

/** Fills an element with a file's name, its extension in a lighter color. */
export function setFileName(el: HTMLElement, name: string): HTMLElement {
  const [stem, ext] = splitExtension(name);
  el.replaceChildren(stem);
  if (ext) {
    const span = document.createElement('span');
    span.className = 'wm-file-ext';
    span.textContent = ext;
    el.append(span);
  }
  return el;
}
