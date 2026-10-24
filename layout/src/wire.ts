// Laid-out pages as plain data: typed arrays and JSON-safe values only, so they can be
// transferred from a worker without copying, sent over a socket by a server, or cached.
// Model objects never cross: hit testing and caret placement happen where the model is.

import type { ImageItem, PageLayout } from './display.ts';
import type { FaceMetrics } from './fonts/faceMetrics.ts';

/** What a renderer needs to draw a face: its atlas image and per-glyph quads. */
export interface FaceDescriptor {
  /** Stable face id: the atlas path relative to the font manifest. */
  key: string;
  atlasWidth: number;
  atlasHeight: number;
  /** Atlas distance range divided by atlas pixels per em: the SDF range in ems. */
  distanceRangeEm: number;
  /**
   * 8 floats per glyph index: plane left, top, right, bottom (ems, relative to the pen
   * position, y down), then atlas left, top, right, bottom (0-1 UVs). Zeros for blank glyphs.
   */
  glyphTable: Float32Array;
  /** The atlas image (RGBA, atlasWidth by atlasHeight), for a face built at runtime; otherwise it loads from `key`. */
  pixels?: Uint8Array;
}

export function describeFace(metrics: FaceMetrics): FaceDescriptor {
  const { atlas, glyphs } = metrics.layout;
  const table = new Float32Array(glyphs.length * 8);
  glyphs.forEach((glyph, i) => {
    const plane = glyph.planeBounds;
    const box = glyph.atlasBounds;
    if (!plane || !box) return;
    table.set(
      [plane.left, plane.top, plane.right, plane.bottom,
        box.left / atlas.width, box.top / atlas.height, box.right / atlas.width, box.bottom / atlas.height],
      i * 8,
    );
  });
  return {
    key: metrics.face.atlas,
    atlasWidth: atlas.width,
    atlasHeight: atlas.height,
    distanceRangeEm: atlas.distanceRange / atlas.size,
    glyphTable: table,
    ...(metrics.pixels && { pixels: metrics.pixels }),
  };
}

/** One face's glyphs on a page, in the GLYPH_INSTANCE_BYTES format. */
export interface EncodedText {
  /** FaceDescriptor.key. */
  face: string;
  syntheticItalic: boolean;
  syntheticBold: boolean;
  count: number;
  /** May be longer than count instances (spare capacity is transferred, not copied). */
  instances: ArrayBuffer;
}

export interface EncodedRects {
  count: number;
  /** RECT_INSTANCE_BYTES format; may have spare capacity. */
  instances: ArrayBuffer;
}

export interface EncodedPage {
  /** PageLayout.id: stable while re-layout keeps the page. */
  id: number;
  index: number;
  width: number;
  height: number;
  section: number;
  number: number;
  text: EncodedText[];
  background: EncodedRects;
  foreground: EncodedRects;
  images: Omit<ImageItem, 'drawing'>[];
  glyphCount: number;
}

/**
 * Encodes a page. The page's instance buffers move into the result (the page must not be
 * used afterwards); `transferables` lists what to transfer when posting it.
 */
export function encodePage(page: PageLayout): { page: EncodedPage; faces: FaceMetrics[]; transferables: ArrayBuffer[] } {
  const transferables: ArrayBuffer[] = [];
  const faces: FaceMetrics[] = [];
  const text: EncodedText[] = [];
  let glyphCount = 0;
  for (const list of page.glyphs.values()) {
    if (list.count === 0) continue;
    faces.push(list.metrics);
    text.push({
      face: list.metrics.face.atlas,
      syntheticItalic: list.font.syntheticItalic,
      syntheticBold: list.font.syntheticBold,
      count: list.count,
      instances: list.buffer,
    });
    glyphCount += list.count;
    transferables.push(list.buffer);
  }
  const rects = (list: PageLayout['background']): EncodedRects => {
    transferables.push(list.buffer);
    return { count: list.count, instances: list.buffer };
  };

  return {
    page: {
      id: page.id,
      index: page.index,
      width: page.width,
      height: page.height,
      section: page.section,
      number: page.number,
      text,
      background: rects(page.background),
      foreground: rects(page.foreground),
      images: page.images.map(({ drawing: _drawing, ...image }) => image),
      glyphCount,
    },
    faces,
    transferables,
  };
}
