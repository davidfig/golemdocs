// Markdown: the handler used when a Markdown file is opened or exported to. It is a few lines, so it
// is always at hand; the Markdown reader and writer it uses are fetched the first time (one chunk,
// one request, where a lazily loaded handler that then loaded them took two in a row).

import { splitFrontMatter } from '../frontMatter.ts';
import type { FormatHandler } from '../convert.ts';

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

const handler: FormatHandler = {
  async read(bytes) {
    const { frontMatter, body } = splitFrontMatter(decoder.decode(bytes));
    const { markdownToDocument } = await import('../markdown.ts');
    const document = await markdownToDocument(body);
    return { document, extensions: frontMatter === null ? {} : { md: { frontMatter } } };
  },
  async write(document, extensions) {
    const { documentToMarkdown } = await import('../markdown.ts');
    if (extensions.md?.frontMatter !== undefined) {
      return encoder.encode(`---\n${extensions.md.frontMatter}\n---\n\n${documentToMarkdown(document)}`);
    }
    return encoder.encode(documentToMarkdown(document));
  },
};

export default handler;
