// Markdown: the handler loaded when a Markdown file is opened or exported to.

import { documentToMarkdown, markdownToDocument } from '../markdown.ts';
import { splitFrontMatter } from '../frontMatter.ts';
import type { FormatHandler } from '../convert.ts';

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

const handler: FormatHandler = {
  async read(bytes) {
    const { frontMatter, body } = splitFrontMatter(decoder.decode(bytes));
    const document = await markdownToDocument(body);
    return { document, extensions: frontMatter === null ? {} : { md: { frontMatter } } };
  },
  async write(document, extensions) {
    if (extensions.md?.frontMatter !== undefined) {
      return encoder.encode(`---\n${extensions.md.frontMatter}\n---\n\n${documentToMarkdown(document)}`);
    }
    return encoder.encode(documentToMarkdown(document));
  },
};

export default handler;
