// The XML document formats: DocBook, JATS, FictionBook and OPML. Each reads XML into an outline and writes an outline
// as XML (see ../outline.ts and ../xmlOutline.ts); they share one chunk, apart from the markup formats', as few
// documents are ever in them.

import { parseDocbook, renderDocbook } from '../docbook.ts';
import { parseFb2, renderFb2 } from '../fb2.ts';
import { parseJats, renderJats } from '../jats.ts';
import { parseOpml, renderOpml } from '../opml.ts';
import { outlineHandler } from '../outline.ts';
import { decodeXml } from '../xmlOutline.ts';

export const docbook = outlineHandler(parseDocbook, renderDocbook, decodeXml);
export const jats = outlineHandler(parseJats, renderJats, decodeXml);
export const fb2 = outlineHandler(parseFb2, renderFb2, decodeXml);
export const opml = outlineHandler(parseOpml, renderOpml, decodeXml);
