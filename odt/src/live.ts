// Live blocks (golemdocs docs/live-blocks.md) in OpenDocument. In the model a live block is a content control (a Word sdt)
// tagged `live:<source> by=<who> stamp=<hash>`. ODF has no content controls, so a block-level one is written as a section
// named with its tag, and an inline one as a text-input field described by it, or, when its text is formatted (bold in
// part, a picture), as a text:meta holding its spans with the tag in its RDFa content; all come back as the content
// control on reading. Only the tag's prefix is known here: what the tag means is the app's business.
//
// LibreOffice's own ODT keeps Word's content controls as `loext:content-control` with `loext:tag`: a .docx converted to
// ODT there has its live values in them, and a live table's tag in its first cell (`loext:plain-text`, as in a .docx it
// saves: docx liveRepair.ts). Both are read as live blocks, the table's put back around the table.
//
// Section names must be unique (LibreOffice renames a repeated one to "Section1", losing the tag), so the second block
// with the same tag is named `<tag> copy=2`, the third `copy=3`, and the suffix is dropped again on reading.

import type { Block, Inline, Wrapper, XmlElement } from '@golemdocs/docx';

export const LIVE_PREFIX = 'live:';

/** The tag of a live block's content control, or null for anything else. */
export function liveTagOf(node: Block | Inline): string | null {
  if (node.kind !== 'wrapper' || node.shell.name !== 'w:sdt') return null;
  for (const c of node.shell.children) {
    if (typeof c === 'string' || c.name !== 'w:sdtPr') continue;
    for (const t of c.children) if (typeof t !== 'string' && t.name === 'w:tag' && t.attrs['w:val']?.startsWith(LIVE_PREFIX)) return t.attrs['w:val'];
  }
  return null;
}

/** A live block's content control with the tag read from a section's name or a field's description; plain text (`w:text`) for one LibreOffice marked so. */
export function liveWrapperOf<T extends Block | Inline>(tag: string, children: T[], plainText = false): Wrapper<T> {
  const properties: XmlElement = { name: 'w:sdtPr', attrs: {}, children: [{ name: 'w:tag', attrs: { 'w:val': tag }, children: [] }, { name: 'w:lock', attrs: { 'w:val': 'sdtContentLocked' }, children: [] }] };
  if (plainText) properties.children.push({ name: 'w:text', attrs: {}, children: [] });
  return { kind: 'wrapper', shell: { name: 'w:sdt', attrs: {}, children: [properties] }, contentElement: 'w:sdtContent', children };
}

/** What follows a repeated tag in a section's name to keep the names unique. */
const COPY = / copy=[0-9]+$/;

/** A unique section name for a live block's tag: the tag itself, or the tag and ` copy=<n>` when it is taken. */
export function liveSectionName(tag: string, used: Set<string>): string {
  let name = COPY.test(tag) ? `${tag} copy=1` : tag;
  for (let n = 2; used.has(name); n++) name = `${tag} copy=${n}`;
  used.add(name);
  return name;
}

/** The tag a live block's section name holds (live.ts's `copy=` suffix dropped), or null when it is not a live block's. */
export function liveTagOfSectionName(name: string | undefined): string | null {
  return name?.startsWith(LIVE_PREFIX) ? name.replace(COPY, '') : null;
}

/** The RDFa property marking a live value's text:meta (its prefix is declared on the element; LibreOffice renames it). */
export const LIVE_META_NS = 'urn:golemdocs:';
export const LIVE_META_PROPERTY = 'golem:live';
