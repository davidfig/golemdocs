// The app's fonts as a worker loads them: the manifest first, then each face's metrics and atlas, or a font file, when
// something asks for it (`FontSet.ensure`, `fontFile`). The layout worker and the vault's convert worker load them the same way.

import { FontSet } from '@golemdocs/layout';
import { FONT_BASE } from '../layout/protocol.ts';

/** A font file (a face's program, for a PDF) at a path relative to the manifest. */
export async function fontFile(path: string): Promise<Uint8Array> {
  const response = await fetch(FONT_BASE + path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export function loadAppFonts(): Promise<FontSet> {
  return FontSet.load(async (path) => {
    const response = await fetch(FONT_BASE + path);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}. Run \`pnpm fonts\`.`);
    return response.json();
  }, fontFile);
}
