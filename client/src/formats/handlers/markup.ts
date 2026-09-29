// The lightweight markup formats: LaTeX, AsciiDoc, reStructuredText and Org. Each reads text into an
// outline and writes an outline as text (see ../outline.ts); they share one chunk with it.

import { parseAsciidoc, renderAsciidoc } from '../asciidoc.ts';
import { parseLatex, renderLatex } from '../latex.ts';
import { parseOrg, renderOrg } from '../org.ts';
import { documentToOutline, outlineToDocument } from '../outline.ts';
import type { Node } from '../outline.ts';
import { parseRst, renderRst } from '../rst.ts';
import type { FormatHandler } from '../convert.ts';

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

function handler(parse: (text: string) => Node[], render: (nodes: readonly Node[]) => string): FormatHandler {
  return {
    async read(bytes) {
      return { document: await outlineToDocument(parse(decoder.decode(bytes))), extensions: {} };
    },
    async write(document) {
      return encoder.encode(render(documentToOutline(document)));
    },
  };
}

export const tex = handler(parseLatex, renderLatex);
export const adoc = handler(parseAsciidoc, renderAsciidoc);
export const rst = handler(parseRst, renderRst);
export const org = handler(parseOrg, renderOrg);
