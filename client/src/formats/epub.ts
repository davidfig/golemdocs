// EPUB: an e-book, a ZIP of XHTML chapters described by a package (.opf) file. Reading joins
// the chapters, in reading order, into one document (images stay placeholders, as for HTML).
// Writing makes a single-chapter EPUB 3 of the document's HTML.

import { ZipArchive, parseXml, writeZip } from '@word/docx';
import type { XmlElement } from '@word/docx';
import { t } from '../i18n/index.ts';

const local = (name: string): string => name.slice(name.indexOf(':') + 1);
const elements = (e: XmlElement): XmlElement[] => e.children.filter((c): c is XmlElement => typeof c !== 'string');
const named = (e: XmlElement | undefined, name: string): XmlElement[] => (e ? elements(e).filter((c) => local(c.name) === name) : []);

/** Resolves `href` against the folder of the package file, undoing URL escapes and dropping fragments. */
function resolve(base: string, href: string): string {
  const parts = base.split('/').slice(0, -1);
  let path = href.split('#')[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // A stray "%" that isn't an escape: the address as written.
  }
  for (const segment of path.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment && segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

/**
 * The book's chapters as one HTML string, in spine order, its title if it has one, and its pictures.
 * Each <img> address is rewritten to the picture's path in the book, which `images` is keyed by.
 */
export async function epubToHtml(bytes: Uint8Array): Promise<{ html: string; title: string | null; images: Map<string, Uint8Array> }> {
  const zip = ZipArchive.read(bytes);
  const text = async (name: string) => (await zip.entries.get(name)?.text()) ?? null;
  const container = await text('META-INF/container.xml');
  if (!container) throw new Error(t('app.notEpub'));
  const rootfile = named(named(parseXml(container), 'rootfiles')[0], 'rootfile')[0];
  const opfPath = rootfile?.attrs['full-path'];
  const opf = opfPath ? await text(opfPath) : null;
  if (!opfPath || !opf) throw new Error(t('app.epubNoPackage'));

  const pkg = parseXml(opf);
  const manifest = new Map<string, XmlElement>();
  for (const item of named(named(pkg, 'manifest')[0], 'item')) manifest.set(item.attrs.id, item);
  const title = named(named(pkg, 'metadata')[0] ?? pkg, 'title')[0]?.children.find((c) => typeof c === 'string');

  let html = '';
  const wanted = new Set<string>();
  for (const ref of named(named(pkg, 'spine')[0], 'itemref')) {
    const item = manifest.get(ref.attrs.idref);
    if (!item || !/x?html/.test(item.attrs['media-type'] ?? '') || ref.attrs.linear === 'no') continue;
    const chapter = await text(resolve(opfPath, item.attrs.href));
    if (chapter === null) continue;
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(chapter)?.[1] ?? chapter;
    const chapterPath = resolve(opfPath, item.attrs.href);
    html += body.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi, (whole, before: string, quote: string, src: string) => {
      if (/^(data:|https?:|\/\/)/i.test(src)) return whole;
      try {
        const path = resolve(chapterPath, src.replace(/&amp;/g, '&'));
        wanted.add(path);
        return `${before}${quote}${path.replace(/&/g, '&amp;')}${quote}`;
      } catch {
        return whole;
      }
    });
    html += '\n';
  }
  const images = new Map<string, Uint8Array>();
  for (const path of wanted) {
    const entry = zip.entries.get(path);
    if (entry) images.set(path, await entry.read().catch(() => new Uint8Array(0)));
  }
  if (!html.trim()) throw new Error(t('app.epubNoChapters'));
  return { html: `<html><body>${html}</body></html>`, title: typeof title === 'string' ? title.trim() : null, images };
}

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** HTML5 as XHTML: void elements self-closed, valueless attributes given values, no named entities beyond XML's. */
export function xhtmlize(html: string): string {
  return html
    .replace(/&nbsp;/g, '&#160;')
    .replace(/<!DOCTYPE[^>]*>\s*/i, '')
    .replace(/<html\b([^>]*)>/i, (_, attrs: string) => `<html xmlns="http://www.w3.org/1999/xhtml"${attrs}>`)
    .replace(/<(meta|link|br|hr|img|input|col|wbr)\b([^>]*?)\s*\/?>/gi, '<$1$2/>')
    // Every valueless data- attribute of a tag gets a value; text inside quoted values is left alone.
    .replace(/<[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => tag.replace(/("[^"]*"|'[^']*')|(\s)(data-[\w-]+)(?=[\s>/])/g, (_m, quoted: string | undefined, space: string, name: string) => quoted ?? `${space}${name}=""`));
}

/** A picture in the book: its path under OEBPS, type and bytes. */
export interface EpubImage {
  href: string;
  mime: string;
  bytes: Uint8Array;
}

export async function htmlToEpub(html: string, title: string, images: EpubImage[] = []): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const file = (name: string, content: string, compress = true) => ({ name, data: encoder.encode(content), compress });
  const heading = xmlEscape(title || t('app.untitled'));
  const chapter = `<?xml version="1.0" encoding="utf-8"?>\n${xhtmlize(html)}`;
  const id = `urn:uuid:${crypto.randomUUID()}`;
  return writeZip([
    file('mimetype', 'application/epub+zip', false),
    file(
      'META-INF/container.xml',
      '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>' +
        '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    file(
      'OEBPS/content.opf',
      `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">` +
        `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${id}</dc:identifier><dc:title>${heading}</dc:title><dc:language>en</dc:language>` +
        `<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta></metadata>` +
        `<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` +
        `<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>${images.map((image, i) => `<item id="img${i + 1}" href="${xmlEscape(image.href)}" media-type="${image.mime}"/>`).join('')}</manifest><spine><itemref idref="chapter"/></spine></package>`,
    ),
    file(
      'OEBPS/nav.xhtml',
      `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${heading}</title></head>` +
        `<body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">${heading}</a></li></ol></nav></body></html>`,
    ),
    file('OEBPS/chapter.xhtml', chapter),
    // Pictures are already compressed.
    ...images.map((image) => ({ name: `OEBPS/${image.href}`, data: image.bytes, compress: false })),
  ]);
}
