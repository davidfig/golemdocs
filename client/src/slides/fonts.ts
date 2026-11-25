// The fonts slides are drawn in (docs/slides.md). A slide names a family (Calibri, Aptos, Gill Sans...): one the app has a
// substitute for (fonts/manifest.json, the same table documents use) is drawn from that substitute's font file, loaded as a web
// font the first time a slide uses it; a family the computer itself has is drawn in that; anything else falls back as
// documents do. Text is measured with the canvas in the same font it is drawn in, so lines break where they are painted.

import { FontSet, type ResolvedFont } from '@golemdocs/layout';
import type { FontSpec, TextMeasure } from './textLayout.ts';

interface Face {
  css: string;
  ready: boolean;
  metrics: { ascent: number; descent: number };
}

const DEFAULT_METRICS = { ascent: 0.952, descent: 0.269 };

export class SlideFonts implements TextMeasure {
  /** Goes up when a font arrives: what was measured before it is measured again. */
  version = 0;
  private readonly faces = new Map<string, Face>();
  private readonly local = new Map<string, boolean>();
  private readonly widths = new Map<string, number>();
  private readonly ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private timer = 0;

  private constructor(
    private readonly set: FontSet | null,
    private readonly base: string,
    private readonly onLoad: () => void,
  ) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  }

  static async create(base: string, onLoad: () => void): Promise<SlideFonts> {
    const root = new URL(base, location.href);
    const set = await FontSet.load(async (path) => {
      const response = await fetch(new URL(path, root));
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return response.json();
    }).catch(() => null);
    return new SlideFonts(set, root.href, onLoad);
  }

  /** Whether the computer has a family of its own (it measures differently from two generic fallbacks). */
  private hasLocal(family: string): boolean {
    const known = this.local.get(family);
    if (known !== undefined) return known;
    const probe = 'mmmmmmmmmmlli1WQ@';
    let found = false;
    for (const generic of ['monospace', 'serif']) {
      this.ctx.font = `40px ${generic}`;
      const plain = this.ctx.measureText(probe).width;
      this.ctx.font = `40px "${family.replace(/"/g, '')}", ${generic}`;
      if (this.ctx.measureText(probe).width !== plain) found = true;
    }
    this.local.set(family, found);
    return found;
  }

  private face(spec: FontSpec): Face {
    const key = `${spec.family}|${spec.bold ? 1 : 0}${spec.italic ? 1 : 0}`;
    let face = this.faces.get(key);
    if (face) return face;
    const known = this.set?.isKnown(spec.family);
    if (!known && this.hasLocal(spec.family)) {
      face = { css: `"${spec.family.replace(/"/g, '')}", sans-serif`, ready: true, metrics: DEFAULT_METRICS };
      this.faces.set(key, face);
      return face;
    }
    let resolved: ResolvedFont | null = null;
    try {
      resolved = this.set ? this.set.resolve({ font: spec.family, bold: spec.bold, italic: spec.italic }) : null;
    } catch {
      resolved = null;
    }
    const m = resolved?.face.metrics;
    const metrics = m ? { ascent: m.hhea.ascender / m.unitsPerEm, descent: -m.hhea.descender / m.unitsPerEm } : DEFAULT_METRICS;
    if (!resolved?.face.font) {
      face = { css: 'sans-serif', ready: true, metrics };
      this.faces.set(key, face);
      return face;
    }
    const family = `golem-slide-${resolved.family.id}-${resolved.face.weight}${resolved.face.italic ? 'i' : ''}`;
    face = { css: `"${family}", sans-serif`, ready: false, metrics };
    this.faces.set(key, face);
    const made = face;
    const sameFile = [...this.faces.values()].find((f) => f !== made && f.css === made.css);
    if (sameFile) {
      made.ready = sameFile.ready;
      if (made.ready) return made;
    }
    if (typeof FontFace === 'undefined') return face;
    new FontFace(family, `url(${new URL(resolved.face.font, this.base).href})`, { weight: String(resolved.face.weight), style: resolved.face.italic ? 'italic' : 'normal' })
      .load()
      .then((loaded) => {
        (document.fonts as FontFaceSet & { add(face: FontFace): void }).add(loaded);
        for (const f of this.faces.values()) if (f.css === made.css) f.ready = true;
        this.widths.clear();
        this.version++;
        // Several faces arrive together: one redraw.
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => this.onLoad(), 30);
      })
      .catch(() => {
        made.css = 'sans-serif';
        made.ready = true;
      });
    return face;
  }

  /** The CSS family list a run is drawn in (the substitute until its file has arrived). */
  family(spec: FontSpec): string {
    const face = this.face(spec);
    return face.ready ? face.css : 'sans-serif';
  }

  /** Whether every font asked for so far has arrived (a thumbnail or an export waits for them). */
  get settled(): boolean {
    for (const f of this.faces.values()) if (!f.ready) return false;
    return true;
  }

  width(text: string, spec: FontSpec): number {
    const css = this.family(spec);
    const key = `${css}|${spec.bold ? 'b' : ''}${spec.italic ? 'i' : ''}|${text}`;
    const known = this.widths.get(key);
    // Widths are kept at a size of 100 and scaled, so the same text at another size costs nothing.
    if (known !== undefined) return (known * spec.size) / 100;
    this.ctx.font = `${spec.italic ? 'italic ' : ''}${spec.bold ? 'bold ' : ''}100px ${css}`;
    const w = this.ctx.measureText(text).width;
    if (this.widths.size > 50000) this.widths.clear();
    this.widths.set(key, w);
    return (w * spec.size) / 100;
  }

  metrics(family: string): { ascent: number; descent: number } {
    return this.face({ family, bold: false, italic: false, size: 10 }).metrics;
  }
}
