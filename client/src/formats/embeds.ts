// Resolving Obsidian-style embeds (`![[picture.png]]`, `![[Note]]`) in a Markdown document: looking up what they stand for and putting
// it in place. How an embed is in the model, resolved or not, and how it is written back is in embedMarks.ts.

import { paragraphText, paragraphsIn } from '@golemdocs/docx';
import type { Block, Inline, WordDocument } from '@golemdocs/docx';
import { collapseDocument, collapseEmbeds, EMBED_PREFIX, embedWrapper, placeholderBody } from './embedMarks.ts';
import { pastedFrom } from './paste.ts';
import { sniffImage } from './images.ts';
import { normalizeTitle, parseDocAddress, readWikiLink } from './wikiLinks.ts';

/** A name that is a picture the page can draw (SVG is left as a link: the document holds pictures, not drawings). */
const PICTURE_NAME = /\.(png|jpe?g|webp|gif|bmp)$/i;

/** What an embedded document looks up as. */
export type Embedded = { kind: 'image'; bytes: Uint8Array } | { kind: 'document'; document: WordDocument };
/** Finds a stored document by title: its picture, or its text as a document. Null when there is none. */
export type EmbedLookup = (title: string) => Promise<Embedded | null>;

// --- Resolving ---------------------------------------------------------------------------------

const EMU_PER_PIXEL = 9525;

/** A size written after a bar (`300`, `300x200`), or null when the text after the bar is a caption. */
function sizeOf(label: string): { width: number; height?: number } | null {
  const m = /^(\d{1,5})(?:x(\d{1,5}))?$/.exec(label.trim());
  return m ? { width: Number(m[1]), ...(m[2] && { height: Number(m[2]) }) } : null;
}

/** The title, section and label an embed's body names. */
function parts(body: string): { title: string; section: string; label: string } {
  const link = readWikiLink(`![[${body}]]`, 0);
  const doc = link && parseDocAddress(link.address);
  const bar = body.indexOf('|');
  return { title: doc?.title ?? body, section: doc?.section ?? '', label: bar < 0 ? '' : body.slice(bar + 1).trim() };
}

/** The title an embedded picture or note is looked up by (the target as written, without its section). */
export function embedTitles(document: WordDocument): string[] {
  const titles = new Set<string>();
  for (const p of paragraphsIn(document.body)) {
    for (const inline of p.children) {
      const body = inline.kind === 'hyperlink' ? placeholderBody(inline) : null;
      if (body !== null) titles.add(parts(body).title);
    }
  }
  return [...titles];
}

/** The blocks under the heading called `section` (up to the next heading as high or higher), or null when there is no such heading. */
function sectionOf(blocks: Block[], section: string): Block[] | null {
  const level = (b: Block): number => (b.kind === 'paragraph' ? Number(/^Heading([1-6])$/.exec(b.properties.style ?? '')?.[1] ?? 0) : 0);
  const wanted = normalizeTitle(section);
  const start = blocks.findIndex((b) => b.kind === 'paragraph' && level(b) > 0 && normalizeTitle(paragraphText(b)) === wanted);
  if (start < 0) return null;
  let end = start + 1;
  while (end < blocks.length && !(level(blocks[end]) > 0 && level(blocks[end]) <= level(blocks[start]))) end++;
  return blocks.slice(start + 1, end);
}

/** Paragraphs of an embedded note are marked off from the text around them by a rule down the left, as Obsidian does. */
function setApart(blocks: Block[]): void {
  for (const block of blocks) {
    if (block.kind !== 'paragraph') continue;
    const left = block.properties.indent?.left ?? 0;
    block.properties = { ...block.properties, indent: { ...block.properties.indent, left: left + 240 }, borders: { ...block.properties.borders, left: { val: 'single', sz: 12, space: 8, color: 'BFBFBF' } } };
  }
}

/** The embedded note's blocks as they can go in `into`: styles and lists they use defined there, and a rule down their left. Null when it has nothing. */
function noteBlocks(note: WordDocument, section: string, into: WordDocument): Block[] | null {
  const copy = Object.create(note) as WordDocument;
  copy.body = collapseEmbeds(note.body);
  let blocks = copy.body;
  if (section) {
    const found = sectionOf(blocks, section);
    if (!found) return null;
    copy.body = blocks = found;
  }
  const pasted = pastedFrom(copy, into, true);
  if (!pasted) return null;
  for (const op of pasted.define) {
    if (op.type === 'setStyle' && op.style) into.styles = { ...into.styles, styles: [...into.styles.styles, op.style] };
    else if (op.type === 'setList' && op.list) {
      const numbering = into.numbering;
      into.numbering = { ...numbering, instances: [...numbering.instances, op.list.instance], abstracts: [...numbering.abstracts, op.list.abstract] };
    }
  }
  setApart(pasted.blocks);
  return pasted.blocks;
}

/** Some embedded notes can be this many blocks long at most (a vault's index note can be huge). */
const MOST_BLOCKS = 5000;

/**
 * Looks up the pictures and notes the unresolved embeds of a document stand for and puts them in place: a picture where the
 * link is (inline, as wide as it says or as it is, no wider than the text), a note's text where its link stands alone in a
 * paragraph. An embed whose target isn't found (or can't be shown) stays the link it is. Embeds already resolved are made
 * links first, so they are looked up afresh.
 */
export async function resolveEmbeds(document: WordDocument, lookup: EmbedLookup): Promise<void> {
  collapseDocument(document);
  const titles = embedTitles(document);
  if (!titles.length) return;
  const found = new Map<string, Embedded | null>();
  await Promise.all(titles.map(async (title) => found.set(title, await lookup(title).catch(() => null))));

  const { pageSize, margins } = document.section;
  const most = ((pageSize?.w ?? 12240) - (margins?.left ?? 1440) - (margins?.right ?? 1440)) * 635;
  const pictures = new Map<string, string>();
  const picture = (body: string, bytes: Uint8Array, title: string): Inline | null => {
    const image = sniffImage(bytes);
    if (!image) return null;
    const { label } = parts(body);
    const size = sizeOf(label);
    let width = (size?.width ?? Math.max(image.width, 1)) * EMU_PER_PIXEL;
    let height = size?.height ? size.height * EMU_PER_PIXEL : Math.round((width * Math.max(image.height, 1)) / Math.max(image.width, 1));
    if (most > 0 && width > most) {
      height = Math.round((height * most) / width);
      width = most;
    }
    let part = pictures.get(title);
    if (!part) pictures.set(title, (part = document.addImage(bytes, image.type)));
    return { kind: 'run', properties: {}, content: [{ kind: 'drawing', inline: true, width, height, image: part, name: `${EMBED_PREFIX}${body}`, description: size || !label ? title : label }], attrs: {} };
  };

  const replaceInlines = (inlines: Inline[]): Inline[] =>
    inlines.map((inline): Inline => {
      const body = inline.kind === 'hyperlink' ? placeholderBody(inline) : null;
      if (body === null) return inline;
      const { title } = parts(body);
      const embedded = found.get(title);
      if (embedded?.kind === 'image' && PICTURE_NAME.test(title)) return picture(body, embedded.bytes, title) ?? inline;
      return inline;
    });
  for (const p of paragraphsIn(document.body)) p.children = replaceInlines(p.children);

  // A note goes where its link is alone in a paragraph of its own.
  let budget = MOST_BLOCKS;
  const body = document.body;
  for (let i = 0; i < body.length; i++) {
    const block = body[i];
    if (block.kind !== 'paragraph' || block.children.length !== 1 || block.properties.numbering) continue;
    const link = block.children[0];
    const text = link.kind === 'hyperlink' ? placeholderBody(link) : null;
    if (text === null) continue;
    const { title, section } = parts(text);
    const embedded = found.get(title);
    if (embedded?.kind !== 'document') continue;
    const blocks = noteBlocks(embedded.document, section, document);
    if (!blocks || blocks.length > budget) continue;
    budget -= blocks.length;
    body[i] = embedWrapper(text, blocks);
  }
}
