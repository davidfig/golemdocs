// The lightweight markup formats: LaTeX, AsciiDoc, reStructuredText, Org, MediaWiki, Textile and Typst. Each reads
// text into an outline and writes an outline as text (see ../outline.ts); they share one chunk with it.

import { parseAsciidoc, renderAsciidoc } from '../asciidoc.ts';
import { parseMediaWiki, renderMediaWiki } from '../mediawiki.ts';
import { parseTextile, renderTextile } from '../textile.ts';
import { parseLatex, renderLatex } from '../latex.ts';
import { parseOrg, renderOrg } from '../org.ts';
import { outlineHandler as handler } from '../outline.ts';
import { parseRst, renderRst } from '../rst.ts';
import { parseTypst, renderTypst } from '../typst.ts';

export const tex = handler(parseLatex, renderLatex);
export const adoc = handler(parseAsciidoc, renderAsciidoc);
export const rst = handler(parseRst, renderRst);
export const org = handler(parseOrg, renderOrg);
export const mediawiki = handler(parseMediaWiki, renderMediaWiki);
export const textile = handler(parseTextile, renderTextile);
export const typst = handler(parseTypst, renderTypst);
