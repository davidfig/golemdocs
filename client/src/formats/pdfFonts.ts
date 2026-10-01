// The font files edits to a PDF may need: an edit that sets text in one of the app's families (Arial, Calibri...) has that
// family's font written into the file, which needs its font file. Files are fetched only when an edit asks for one, and kept;
// applying edits is synchronous, so what they need is loaded before (`ensure`) and looked up by `fontFile`.

import type { FontSet } from '@golemdocs/layout';
import { isStandardName, type ApplyOptions, type PdfEdit } from '@golemdocs/pdf';

export class EditFonts {
  private readonly bytes = new Map<string, Uint8Array>();
  private readonly loading = new Map<string, Promise<void>>();

  constructor(
    private readonly fonts: FontSet,
    /** The font file at a path relative to the manifest. */
    private readonly fetchFile: (path: string) => Promise<Uint8Array>,
  ) {}

  /** The file of a family in a style, if the app has the family and can embed it. */
  path(family: string, bold: boolean, italic: boolean): string | undefined {
    if (isStandardName(family) || !this.fonts.isKnown(family)) return undefined;
    const face = this.fonts.resolve({ font: family, bold, italic }).face;
    return face.font;
  }

  /** Families the app has a font file for (the ones text in a PDF can be set in). */
  get families(): string[] {
    return this.fonts.families.filter((f) => !f.cjk && !f.math && f.faces.some((face) => face.font)).map((f) => f.wordName);
  }

  /** Loads a family's file in a style (nothing, for a family with none). */
  load(family: string, bold: boolean, italic: boolean): Promise<void> {
    const path = this.path(family, bold, italic);
    if (!path || this.bytes.has(path)) return Promise.resolve();
    let pending = this.loading.get(path);
    if (!pending) {
      pending = this.fetchFile(path).then(
        (bytes) => void this.bytes.set(path, bytes),
        () => void 0, // unreachable file: the nearest standard font is used
      );
      this.loading.set(path, pending);
    }
    return pending;
  }

  /** Loads what a list of edits sets text in. */
  async ensure(edits: readonly PdfEdit[]): Promise<void> {
    const wanted: Promise<void>[] = [];
    for (const e of edits) {
      if (e.kind === 'textbox') wanted.push(this.load(e.font, !!e.bold, !!e.italic));
      else if (e.kind === 'text' && e.style?.font) wanted.push(this.load(e.style.font, !!e.style.bold, !!e.style.italic));
    }
    await Promise.all(wanted);
  }

  /** What `applyEdits` needs. */
  get options(): ApplyOptions {
    return { fontFile: (family, bold, italic) => {
      const path = this.path(family, bold, italic);
      return path ? this.bytes.get(path) : undefined;
    } };
  }
}
