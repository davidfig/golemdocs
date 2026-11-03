// The fonts the embeddable viewer's build bundles (vite.viewer.config.ts): a trimmed copy of the app's font manifest and the files it
// names. A host bundles them so that opening a file fetches nothing from golemdocs.com. A font a document names that isn't in the
// set is drawn in its stand-in (Georgia in Times New Roman, say) or in Calibri (see FALLBACK_BY_NAME in @golemdocs/layout).

import type { FontManifest } from '@golemdocs/layout';

/**
 * The smallest set that shows common Office documents as they were written: Calibri (Word's default, and what every unknown font
 * falls back to; Aptos is drawn in it too), Cambria (headings), Arial, Times New Roman and Courier New (code, and the monospaced
 * fonts). The core atlases hold Latin, Greek and Cyrillic text; extra pages (`<family>-extra`), CJK pages (`noto-sans-*`) and the
 * math font (`libertinus-math`) are left out unless asked for.
 */
export const VIEWER_FONTS: readonly string[] = ['calibri', 'cambria', 'arial', 'times-new-roman', 'courier-new'];

/** Font set names that stand for several families. */
const GROUPS: Record<string, (id: string) => boolean> = {
  /** Every family and page the app has. */
  all: () => true,
  /** The extra pages of the families chosen (accents, symbols and scripts beyond the core atlases). */
  extras: (id) => id.endsWith('-extra'),
  /** Chinese, Japanese and Korean. */
  cjk: (id) => id.startsWith('noto-sans-'),
};

/**
 * The manifest of a font set, and every file it names (paths relative to the manifest). `families` are family ids or group names
 * (`all`, `extras`, `cjk`); Calibri is always in, since everything falls back to it. An extra page is kept only with its family.
 * Font programs (.ttf, only for writing a PDF) are left out unless `withFontFiles`.
 */
export function viewerFontSet(manifest: FontManifest, families: readonly string[] = VIEWER_FONTS, withFontFiles = false): { manifest: FontManifest; files: string[] } {
  const asked = new Set(['calibri', ...families.map((f) => f.trim().toLowerCase()).filter(Boolean)]);
  const wanted = (id: string): boolean => asked.has(id) || Object.entries(GROUPS).some(([group, test]) => asked.has(group) && test(id));
  // An extra page (not a CJK one, whose group is a language) extends its family, and is no use without it.
  const extraPage = (family: FontManifest['families'][number]): boolean => !!family.page && !GROUPS.cjk(family.id);
  const kept = manifest.families.filter((family) => wanted(family.id) && (!extraPage(family) || wanted(family.page!.group)));
  const files = new Set<string>();
  const out = kept.map((family) => {
    if (family.licenseFile) files.add(family.licenseFile);
    if (family.page) files.add(family.page.coverage);
    return {
      ...family,
      faces: family.faces.map((face) => {
        files.add(face.atlas);
        files.add(face.layout);
        if (withFontFiles && face.font) files.add(face.font);
        if (withFontFiles) return face;
        const { font: _font, ...rest } = face;
        return rest;
      }),
    };
  });
  return { manifest: { ...manifest, families: out }, files: [...files].sort() };
}
