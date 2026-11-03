// Emoji in exports (PDF, page images, SVG). An emoji glyph is a color sprite in its page's atlas (see scripts/fonts/emoji.ts),
// not an outline, so exports that draw pictures draw it as one, cut out of the atlas, and exports that write text write
// its characters. The atlas is fetched (as a font file is) only when an export has an emoji in it.

import type { FaceMetrics, FontSet } from '@golemdocs/layout';
import { decodeImage, makeCanvas } from './imageCodec.ts';

/** What an emoji glyph stands for, as text (for copying from a PDF, or an SVG's text). */
export function emojiText(metrics: FaceMetrics, glyph: number): string {
  const entry = metrics.layout.glyphs[glyph];
  const cps = entry?.sequence ?? (entry?.unicode === undefined ? [] : [entry.unicode]);
  return String.fromCodePoint(...cps);
}

/** Where an emoji drawn at pen position (x, y) and `size` points per em goes: its box, in points. */
export function emojiBox(metrics: FaceMetrics, glyph: number, x: number, y: number, size: number): { x: number; y: number; width: number; height: number } | null {
  const plane = metrics.layout.glyphs[glyph]?.planeBounds;
  if (!plane) return null;
  return { x: x + plane.left * size, y: y + plane.top * size, width: (plane.right - plane.left) * size, height: (plane.bottom - plane.top) * size };
}

export interface EmojiSprite {
  /** The whole atlas, and the sprite's rectangle in it (pixels). */
  atlas: ImageBitmap;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** The emoji atlases an export needs, each fetched and decoded once. Where there is no image decoder (a server), there are no sprites. */
export class EmojiSprites {
  private readonly atlases = new Map<string, Promise<ImageBitmap | null>>();

  constructor(private readonly fonts: FontSet) {}

  private atlas(metrics: FaceMetrics): Promise<ImageBitmap | null> {
    const path = metrics.face.atlas;
    let atlas = this.atlases.get(path);
    if (!atlas) {
      atlas = typeof createImageBitmap === 'undefined' ? Promise.resolve(null) : this.fonts.fontFile(path).then((bytes) => (bytes ? decodeImage(bytes, 'webp') : null)).catch(() => null);
      this.atlases.set(path, atlas);
    }
    return atlas;
  }

  async sprite(metrics: FaceMetrics, glyph: number): Promise<EmojiSprite | null> {
    const box = metrics.layout.glyphs[glyph]?.atlasBounds;
    const atlas = box ? await this.atlas(metrics) : null;
    if (!box || !atlas) return null;
    return { atlas, sx: box.left, sy: box.top, sw: box.right - box.left, sh: box.bottom - box.top };
  }

  private readonly pixelCache = new Map<string, Promise<{ width: number; height: number; channels: 4; data: Uint8Array } | null>>();

  /** A sprite's pixels (RGBA, not premultiplied), for a PDF to embed. */
  pixels(metrics: FaceMetrics, glyph: number): Promise<{ width: number; height: number; channels: 4; data: Uint8Array } | null> {
    const key = `${metrics.face.atlas}#${glyph}`;
    let pixels = this.pixelCache.get(key);
    if (!pixels) {
      pixels = this.sprite(metrics, glyph).then((sprite) => {
        if (!sprite) return null;
        const { context } = makeCanvas(sprite.sw, sprite.sh);
        context.drawImage(sprite.atlas, sprite.sx, sprite.sy, sprite.sw, sprite.sh, 0, 0, sprite.sw, sprite.sh);
        const data = context.getImageData(0, 0, sprite.sw, sprite.sh).data;
        return { width: sprite.sw, height: sprite.sh, channels: 4 as const, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
      });
      this.pixelCache.set(key, pixels);
    }
    return pixels;
  }

  close(): void {
    for (const atlas of this.atlases.values()) void atlas.then((a) => a?.close());
    this.atlases.clear();
  }
}
