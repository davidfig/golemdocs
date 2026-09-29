// EPUB and MHTML: web content in a container. Both go through the HTML reader and writer, so they
// share one chunk (and the HTML chunk) instead of each being a few kilobytes of its own.

import { documentToHtml, htmlToDocument } from '../html.ts';
import { paragraphText } from '@word/docx';
import { epubToHtml, htmlToEpub } from '../epub.ts';
import { htmlToMhtml, mhtmlToHtml } from '../mhtml.ts';
import type { FormatHandler } from '../convert.ts';
import type { WordDocument } from '@word/docx';
import { t } from '../../i18n/index.ts';

const titleOf = (document: WordDocument): string => {
  for (const block of document.body) if (block.kind === 'paragraph') { const text = paragraphText(block).trim(); if (text) return text.slice(0, 120); }
  return t('app.untitled');
};

export const epub: FormatHandler = {
  async read(bytes) {
    const { html } = await epubToHtml(bytes);
    const { document, extension } = await htmlToDocument(html);
    return { document, extensions: { html: extension } };
  },
  // The page is regenerated for the document rather than restored from an HTML extension: an EPUB's
  // chapters are XHTML, and the head of an arbitrary web page does not belong in one.
  write: (document) => htmlToEpub(documentToHtml(document), titleOf(document)),
};

export const mhtml: FormatHandler = {
  async read(bytes) {
    const { document, extension } = await htmlToDocument(mhtmlToHtml(bytes));
    return { document, extensions: { html: extension } };
  },
  async write(document, extensions) {
    return htmlToMhtml(documentToHtml(document, extensions.html), titleOf(document));
  },
};
