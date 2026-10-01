// EPUB and MHTML: web content in a container. Both go through the HTML reader and writer, so they
// share one chunk (and the HTML chunk) instead of each being a few kilobytes of its own.

import { documentToHtml, htmlToDocument } from '../html.ts';
import { paragraphText } from '@golemdocs/docx';
import { documentToEml, emailToDocument } from '../eml.ts';
import { epubToHtml, htmlToEpub } from '../epub.ts';
import type { EpubImage } from '../epub.ts';
import { MIME, collectImages } from '../images.ts';
import { htmlToMhtml, readMhtml } from '../mhtml.ts';
import type { MhtmlResource } from '../mhtml.ts';
import { t } from '../../i18n/index.ts';
import type { FormatHandler } from '../convert.ts';
import type { WordDocument } from '@golemdocs/docx';

const titleOf = (document: WordDocument): string => {
  for (const block of document.body) {
    if (block.kind === 'paragraph') {
      const text = paragraphText(block).trim();
      if (text) return text.slice(0, 120);
    }
  }
  return t('app.untitled');
};

export const epub: FormatHandler = {
  async read(bytes) {
    const { html, images } = await epubToHtml(bytes);
    const { document, extension } = await htmlToDocument(html, (src) => images.get(src) ?? null);
    return { document, extensions: { html: extension } };
  },
  // The page is regenerated for the document rather than restored from an HTML extension: an EPUB's
  // chapters are XHTML, and the head of an arbitrary web page does not belong in one.
  async write(document) {
    const found = await collectImages(document);
    const files = new Map<string, EpubImage>();
    let n = 0;
    for (const [part, image] of found) files.set(part, { href: `images/image${++n}.${image.type === 'jpeg' ? 'jpg' : image.type}`, mime: MIME[image.type], bytes: image.bytes });
    const html = documentToHtml(document, undefined, { images: found, imageSrc: (part) => files.get(part)!.href });
    return htmlToEpub(html, titleOf(document), [...files.values()]);
  },
};

export const mhtml: FormatHandler = {
  async read(bytes) {
    const page = readMhtml(bytes);
    const { document, extension } = await htmlToDocument(page.html, (src) => page.resource(src));
    return { document, extensions: { html: extension } };
  },
  async write(document, extensions) {
    const found = await collectImages(document);
    const resources = new Map<string, MhtmlResource>();
    let n = 0;
    for (const [part, image] of found) resources.set(part, { location: `file:///images/image${++n}.${image.type === 'jpeg' ? 'jpg' : image.type}`, mime: MIME[image.type], bytes: image.bytes });
    // The page refers to each picture relative to its own location, file:///document.html.
    const html = documentToHtml(document, extensions.html, { images: found, imageSrc: (part) => resources.get(part)!.location.replace('file:///', '') });
    return htmlToMhtml(html, titleOf(document), [...resources.values()]);
  },
};

/** Email messages: their HTML body goes through the HTML reader, so they share this chunk. */
export const eml: FormatHandler = {
  async read(bytes) {
    const { document, extension } = await emailToDocument(bytes);
    return { document, extensions: { eml: extension } };
  },
  write: (document, extensions) => documentToEml(document, extensions.eml),
};
