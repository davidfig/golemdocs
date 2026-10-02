// A document as a list of plain paragraphs: what a language model reads, and what a search index
// holds. The assistant and the server's document search both use it, so a paragraph number
// means the same thing to each. Numbering is that of `paragraphsIn` (tables included).

import type { WordDocument } from '../docx/document.ts';
import { StyleResolver } from '../model/resolve.ts';
import type { Paragraph } from '../model/types.ts';
import { OBJECT_CHAR, paragraphText, paragraphsIn } from './text.ts';

/** One paragraph of a document, as plain text. */
export interface Segment {
  /** The style's name ("Heading 1"), when it isn't the default one. */
  style?: string;
  text: string;
  /** The paragraph is a bullet or numbered list item. */
  list?: 'bullet' | 'number';
}

/** The document as numbered paragraphs (the first is 0), with their style names and list kinds. */
export function paragraphSegments(doc: WordDocument): Segment[] {
  const resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
  return paragraphsIn(doc.body).map((p: Paragraph) => {
    const named = p.properties.style ? doc.styles.styles.find((s) => s.id === p.properties.style)?.name : undefined;
    const numbering = resolver.paragraph(p.properties).numbering;
    const level = numbering?.id ? resolver.listLevel(numbering.id, numbering.level ?? 0) : undefined;
    return {
      ...(named && !/^normal$/i.test(named) && { style: named }),
      text: paragraphText(p).replaceAll(OBJECT_CHAR, '[object]'),
      ...(level && { list: level.format === 'bullet' ? ('bullet' as const) : ('number' as const) }),
    };
  });
}
