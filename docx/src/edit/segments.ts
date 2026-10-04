// A document as a list of plain paragraphs: what a language model reads, and what a search index
// holds. The assistant and the server's document search both use it, so a paragraph number
// means the same thing to each. Numbering is that of `paragraphsIn` (tables included).

import type { WordDocument } from '../docx/document.ts';
import { StyleResolver } from '../model/resolve.ts';
import type { Paragraph } from '../model/types.ts';
import { docLinkTitles } from '../search/links.ts';
import { OBJECT_CHAR, paragraphText, paragraphsIn } from './text.ts';

/** One paragraph of a document, as plain text. */
export interface Segment {
  /** The style's name ("Heading 1"), when it isn't the default one. */
  style?: string;
  text: string;
  /** The paragraph is a bullet or numbered list item. */
  list?: 'bullet' | 'number';
  /** The titles of the stored documents the paragraph links to (see ../search/links.ts). */
  links?: string[];
}

/** The document as numbered paragraphs (the first is 0), with their style names and list kinds. */
export function paragraphSegments(doc: WordDocument): Segment[] {
  const resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
  return paragraphsIn(doc.body).map((p: Paragraph) => {
    const named = p.properties.style ? doc.styles.styles.find((s) => s.id === p.properties.style)?.name : undefined;
    const numbering = resolver.paragraph(p.properties).numbering;
    const level = numbering?.id ? resolver.listLevel(numbering.id, numbering.level ?? 0) : undefined;
    const links = docLinkTitles(p);
    return {
      ...(named && !/^normal$/i.test(named) && { style: named }),
      text: paragraphText(p).replaceAll(OBJECT_CHAR, '[object]'),
      ...(level && { list: level.format === 'bullet' ? ('bullet' as const) : ('number' as const) }),
      ...(links.length ? { links } : {}),
    };
  });
}

/** Whether stored bytes are a plain text file (the app keeps those as they are): not a ZIP (a .docx, or its own .wdoc), not a PDF, and nothing in its beginning that text does not have (a picture has zero bytes). */
export function isPlainText(bytes: Uint8Array): boolean {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return true;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return false;
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return false;
  for (let i = 0; i < Math.min(bytes.length, 4096); i++) if (bytes[i] === 0) return false;
  return true;
}

/** The text of a plain text file (UTF-8, UTF-16 with a byte order mark, or else Windows-1252), without decoding more than a search could use. */
function decodePlain(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** A plain text file as numbered lines (the first is 0), each a paragraph, as `paragraphSegments` does for a document. */
export function textSegments(bytes: Uint8Array, maxLines = 100_000): Segment[] {
  const out: Segment[] = [];
  const text = decodePlain(bytes);
  let from = 0;
  while (from <= text.length && out.length < maxLines) {
    let end = from;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++;
    out.push({ text: text.slice(from, Math.min(end, from + 2000)) });
    from = text[end] === '\r' && text[end + 1] === '\n' ? end + 2 : end + 1;
    if (end >= text.length) break;
  }
  return out;
}
