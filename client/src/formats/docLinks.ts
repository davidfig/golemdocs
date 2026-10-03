// Writing different link titles into a stored document's bytes, for when the documents they name are
// renamed or moved (see ../linkRename.ts). Works on the model, so it is the same for a document of any
// format: a link is a hyperlink to `doc:Title`, and an embed is an unresolved link or a drawing or content
// control named `embed:Title...` (see embedMarks.ts). Free of the browser.

import { EMBED_PREFIX, WordDocument, docAddress, embedTitle, paragraphsIn, parseDocAddress } from '@golemdocs/docx';
import type { Block, Hyperlink, Inline } from '@golemdocs/docx';
import { isWdoc, readWdoc, writeWdoc } from './wdoc.ts';

/** An embed's body with its title (the part before `#` and `|`) replaced. */
function embedBodyWith(body: string, title: string): string {
  const end = body.search(/[#|]/);
  return `${title}${end < 0 ? '' : body.slice(end)}`;
}

/** A link's text, when it is nothing but plain text runs: the visible target of a `[[Title]]` link. */
function plainText(link: Hyperlink): string | null {
  let text = '';
  for (const child of link.children) {
    if (child.kind !== 'run') return null;
    for (const item of child.content) {
      if (item.kind !== 'text') return null;
      text += item.text;
    }
  }
  return text;
}

function setPlainText(link: Hyperlink, text: string): void {
  let first = true;
  for (const child of link.children) {
    if (child.kind !== 'run') continue;
    for (const item of child.content) {
      if (item.kind !== 'text') continue;
      item.text = first ? text : '';
      first = false;
    }
  }
}

/** Rewrites the links in `inlines`; returns how many changed. */
function rewriteInlines(inlines: readonly Inline[], renames: ReadonlyMap<string, string>): number {
  let changed = 0;
  for (const inline of inlines) {
    if (inline.kind === 'hyperlink') {
      const doc = inline.url ? parseDocAddress(inline.url) : null;
      const next = doc && renames.get(doc.title);
      if (doc && next) {
        // A link that shows its target (`[[Plan]]`) shows the new one; one with its own words (`[[Plan|the plan]]`) keeps them.
        const shown = plainText(inline);
        if (shown === doc.title || (doc.section && shown === `${doc.title}#${doc.section}`)) setPlainText(inline, doc.section && shown !== doc.title ? `${next}#${doc.section}` : next);
        inline.url = docAddress(next, doc.section || undefined);
        changed++;
      }
      changed += rewriteInlines(inline.children, renames);
    } else if (inline.kind === 'wrapper') changed += rewriteInlines(inline.children, renames);
    else if (inline.kind === 'run') {
      for (const item of inline.content) {
        if (item.kind !== 'drawing' || !item.name?.startsWith(EMBED_PREFIX)) continue;
        const body = item.name.slice(EMBED_PREFIX.length);
        const next = renames.get(embedTitle(body));
        if (next) {
          item.name = `${EMBED_PREFIX}${embedBodyWith(body, next)}`;
          changed++;
        }
      }
    }
  }
  return changed;
}

/** Rewrites the tags of embedded notes (content controls) in `blocks`. */
function rewriteEmbeds(blocks: readonly Block[], renames: ReadonlyMap<string, string>): number {
  let changed = 0;
  for (const block of blocks) {
    if (block.kind === 'wrapper') {
      if (block.shell.name === 'w:sdt') {
        const properties = block.shell.children.find((c) => typeof c !== 'string' && c.name === 'w:sdtPr');
        const tag = typeof properties === 'object' ? properties.children.find((c) => typeof c !== 'string' && c.name === 'w:tag') : undefined;
        const value = typeof tag === 'object' ? tag.attrs['w:val'] : undefined;
        if (typeof tag === 'object' && value?.startsWith(EMBED_PREFIX)) {
          const body = value.slice(EMBED_PREFIX.length);
          const next = renames.get(embedTitle(body));
          if (next) {
            tag.attrs['w:val'] = `${EMBED_PREFIX}${embedBodyWith(body, next)}`;
            changed++;
          }
        }
      }
      changed += rewriteEmbeds(block.children, renames);
    } else if (block.kind === 'table') {
      for (const row of block.rows) {
        if (row.kind !== 'row') continue;
        for (const cell of row.cells) if (cell.kind === 'cell') changed += rewriteEmbeds(cell.children, renames);
      }
    }
  }
  return changed;
}

/**
 * The stored document's bytes with its links to the titles in `renames` pointing at the new ones, and how many links changed. Null
 * bytes when none did (or there is no text to change: a PDF not turned into text yet), so the document is left as it is.
 */
export async function rewriteDocumentLinks(bytes: ArrayBuffer, renames: ReadonlyMap<string, string>): Promise<{ bytes: Uint8Array | null; changed: number }> {
  const wdoc = isWdoc(bytes) ? await readWdoc(new Uint8Array(bytes)) : null;
  const docx = wdoc ? wdoc.document : new Uint8Array(bytes);
  if (!docx) return { bytes: null, changed: 0 };
  const doc = await WordDocument.read(docx);
  let changed = rewriteEmbeds(doc.body, renames);
  for (const paragraph of paragraphsIn(doc.body)) changed += rewriteInlines(paragraph.children, renames);
  if (!changed) return { bytes: null, changed: 0 };
  const written = await doc.write();
  return { bytes: wdoc ? await writeWdoc({ ...wdoc, document: written }) : written, changed };
}
