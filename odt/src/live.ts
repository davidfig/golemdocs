// Live blocks (golemdocs docs/live-blocks.md) in OpenDocument. In the model a live block is a content control (a Word sdt)
// tagged `live:<source> stamp=<hash>`. ODF has no content controls, so a block-level one is written as a section named
// with its tag and an inline one as a text-input field described by it; both come back as the content control on reading.
// Only the tag's prefix is known here: what the tag means is the app's business.

import type { Block, Inline, Wrapper } from '@golemdocs/docx';

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

/** A live block's content control with the tag read from a section's name or a field's description. */
export function liveWrapperOf<T extends Block | Inline>(tag: string, children: T[]): Wrapper<T> {
  const properties = { name: 'w:sdtPr', attrs: {}, children: [{ name: 'w:tag', attrs: { 'w:val': tag }, children: [] }, { name: 'w:lock', attrs: { 'w:val': 'sdtContentLocked' }, children: [] }] };
  return { kind: 'wrapper', shell: { name: 'w:sdt', attrs: {}, children: [properties] }, contentElement: 'w:sdtContent', children };
}
