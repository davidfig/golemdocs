// Obsidian-style embeds in Markdown: `![[picture.png]]` shows the picture in place and `![[Note]]` (or `![[Note#Heading]]`) shows
// the other note's text there.
//
// In the model an embed is in one of two states. Unresolved it is a hyperlink to the stored document (`doc:Note`) whose runs use
// the "EmbedLink" style: that is what the Markdown reader makes, and what stays when the target can't be found. Resolved, a
// picture is an inline drawing named `embed:<what was written between the brackets>`, and a note is a block-level content control
// (a Word "sdt", so it survives a conversion to Word) tagged the same way, holding the note's blocks. The Markdown writer turns
// either state back into `![[...]]`: the embedded content is the other document's, so it is never written into this one, and an
// edit made inside it is not kept. When a document is opened, resolved embeds are collapsed and looked up again, so they
// are always as the embedded document is now.
//
// This file is the small part the Markdown reader and writer need; the lookup that resolves embeds is in embeds.ts.

import { EMBED_PREFIX, paragraphsIn } from '@golemdocs/docx';
import type { Block, Hyperlink, Inline, Paragraph, WordDocument, Wrapper } from '@golemdocs/docx';
import { parseDocAddress, readWikiLink } from './wikiLinks.ts';

/** The character style of an unresolved embed's link. */
export const EMBED_STYLE = 'EmbedLink';
export { EMBED_PREFIX };

// --- The two states in the model ---------------------------------------------------------------

/** The hyperlink an unresolved embed is, for what was written between the brackets (`Note#Heading|label`). Null if it isn't one. */
export function embedPlaceholder(body: string): Hyperlink | null {
  const link = readWikiLink(`![[${body}]]`, 0);
  if (!link) return null;
  const run = { kind: 'run' as const, properties: { style: EMBED_STYLE }, content: [{ kind: 'text' as const, text: link.shown }], attrs: {} };
  return { kind: 'hyperlink', url: link.address, children: [run], attrs: {} };
}

/** What was written between the brackets of the embed an unresolved hyperlink stands for, or null when it is any other link. */
export function placeholderBody(link: Hyperlink): string | null {
  if (!link.url || !link.children.length) return null;
  let text = '';
  for (const child of link.children) {
    if (child.kind !== 'run' || child.properties.style !== EMBED_STYLE) return null;
    for (const item of child.content) if (item.kind === 'text') text += item.text;
  }
  const doc = parseDocAddress(link.url);
  if (!doc) return null;
  const target = `${doc.title}${doc.section ? `#${doc.section}` : ''}`;
  return text === target || !text ? target : `${target}|${text}`;
}

/** The body an embed's drawing or content control carries, or null for one that isn't an embed's. */
export function embedTag(block: Block): string | null {
  if (block.kind !== 'wrapper' || block.shell.name !== 'w:sdt') return null;
  const properties = block.shell.children.find((c) => typeof c !== 'string' && c.name === 'w:sdtPr');
  const tag = typeof properties === 'object' ? properties.children.find((c) => typeof c !== 'string' && c.name === 'w:tag') : undefined;
  const value = typeof tag === 'object' ? tag.attrs['w:val'] : undefined;
  return value?.startsWith(EMBED_PREFIX) ? value.slice(EMBED_PREFIX.length) : null;
}

export function embedWrapper(body: string, children: Block[]): Wrapper<Block> {
  const tag = { name: 'w:tag', attrs: { 'w:val': `${EMBED_PREFIX}${body}` }, children: [] };
  return { kind: 'wrapper', shell: { name: 'w:sdt', attrs: {}, children: [{ name: 'w:sdtPr', attrs: {}, children: [tag] }] }, contentElement: 'w:sdtContent', children };
}

const paragraphOf = (children: Inline[]): Paragraph => ({ kind: 'paragraph', properties: {}, children, attrs: {} });

/** The body of the embed a run stands for (a run holding nothing but an embedded picture), or null. */
function drawnBody(inline: Inline): string | null {
  if (inline.kind !== 'run' || inline.content.length !== 1) return null;
  const item = inline.content[0];
  return item.kind === 'drawing' && item.name?.startsWith(EMBED_PREFIX) ? item.name.slice(EMBED_PREFIX.length) : null;
}

/** Inlines with each embedded picture made an unresolved embed again (the same list when there is none). */
function unresolveInlines(inlines: Inline[]): Inline[] {
  let changed = false;
  const out = inlines.map((inline): Inline => {
    const body = drawnBody(inline);
    const placeholder = body === null ? null : embedPlaceholder(body);
    if (placeholder) {
      changed = true;
      return placeholder;
    }
    if (inline.kind === 'wrapper') {
      const children = unresolveInlines(inline.children);
      if (children !== inline.children) {
        changed = true;
        return { ...inline, children };
      }
    }
    return inline;
  });
  return changed ? out : inlines;
}

/** Makes every resolved embed of the blocks unresolved again: a picture a link, a note's content a paragraph with its link. */
export function collapseEmbeds(blocks: Block[]): Block[] {
  return blocks.map((block): Block => {
    const body = embedTag(block);
    const placeholder = body === null ? null : embedPlaceholder(body);
    if (placeholder) return paragraphOf([placeholder]);
    return block;
  });
}

/** Makes every embedded picture of a document an unresolved embed again, and every embedded note's text its link. */
export function collapseDocument(document: WordDocument): void {
  document.body = collapseEmbeds(document.body);
  for (const p of paragraphsIn(document.body)) p.children = unresolveInlines(p.children);
}
