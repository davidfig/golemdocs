// The output of layout: positioned pages, independent of any file format or renderer.
// A WebGL renderer draws these; a PDF exporter could write them; a PDF importer could
// produce them. Coordinates are in points, page-relative, y down.

import type { Drawing, Paragraph } from '@golemdocs/docx';
import type { PageStart } from './document.ts';
import type { SourceSpan } from './offsets.ts';
import type { FaceMetrics } from './fonts/faceMetrics.ts';
import type { ResolvedFont } from './fonts/fontSet.ts';

/** Packs 0xRRGGBB plus alpha (0-1) into little-endian RGBA8 (the renderer's vertex format). */
export function packColor(rgb: number, alpha = 1): number {
  const a = Math.round(Math.min(Math.max(alpha, 0), 1) * 255);
  return (((rgb >> 16) & 0xff) | (rgb & 0xff00) | ((rgb & 0xff) << 16) | (a << 24)) >>> 0;
}

/** RRGGBB hex (as in OOXML) to a packed color; undefined for "auto" or invalid values. */
export function parseHexColor(hex: string | undefined, alpha = 1): number | undefined {
  if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  return packColor(parseInt(hex, 16), alpha);
}

/**
 * Glyph instances as the renderer consumes them, 20 bytes each (little-endian):
 *   0  x, y    float32 x2   pen position on the baseline, page-relative points
 *   8  size    float32      font size in points
 *   12 glyph   uint16       glyph index in the face (its atlas JSON order)
 *   14 (pad)   uint16
 *   16 color   uint32       packed RGBA8 (see packColor)
 * Layout writes this format directly, so pages cross to a worker's host (or over a socket)
 * and into GPU buffers without any conversion.
 */
export const GLYPH_INSTANCE_BYTES = 20;
/** Rectangle instances, 20 bytes: x, y, width, height (float32, points), color (uint32). */
export const RECT_INSTANCE_BYTES = 20;

/** A growable array of 20-byte instances with float32/uint16/uint32 views. */
abstract class InstanceList {
  count = 0;
  buffer = new ArrayBuffer(0);
  protected f32 = new Float32Array(0);
  protected u16 = new Uint16Array(0);
  protected u32 = new Uint32Array(0);

  constructor(private readonly stride: number) {}

  /** Makes room for one more instance and returns its index. */
  protected next(): number {
    if (this.count * this.stride === this.buffer.byteLength) this.reserve(Math.max(64, this.count * 2));
    return this.count++;
  }

  reserve(capacity: number): void {
    if (capacity * this.stride <= this.buffer.byteLength) return;
    const buffer = new ArrayBuffer(capacity * this.stride);
    new Uint8Array(buffer).set(new Uint8Array(this.buffer));
    this.adopt(buffer, this.count);
  }

  /** Takes over a buffer of instances (e.g. one received from a worker). */
  adopt(buffer: ArrayBuffer, count: number): void {
    this.buffer = buffer;
    this.count = count;
    this.f32 = new Float32Array(buffer);
    this.u16 = new Uint16Array(buffer);
    this.u32 = new Uint32Array(buffer);
  }

  /** The instances, without spare capacity. */
  get bytes(): Uint8Array {
    return new Uint8Array(this.buffer, 0, this.count * this.stride);
  }

  append(other: InstanceList): void {
    this.reserve(this.count + other.count);
    new Uint8Array(this.buffer).set(other.bytes, this.count * this.stride);
    this.count += other.count;
  }
}

/** Glyphs of one face (and synthetic style), in the renderer's instance format. */
export class GlyphList extends InstanceList {
  constructor(
    readonly font: ResolvedFont,
    readonly metrics: FaceMetrics,
  ) {
    super(GLYPH_INSTANCE_BYTES);
  }

  push(x: number, y: number, size: number, glyph: number, color: number): void {
    const i = this.next();
    const f = i * 5;
    this.f32[f] = x;
    this.f32[f + 1] = y;
    this.f32[f + 2] = size;
    this.u16[i * 10 + 6] = glyph;
    this.u32[f + 4] = color;
  }

  x(i: number): number {
    return this.f32[i * 5];
  }
  /** Baseline. */
  y(i: number): number {
    return this.f32[i * 5 + 1];
  }
  size(i: number): number {
    return this.f32[i * 5 + 2];
  }
  glyph(i: number): number {
    return this.u16[i * 10 + 6];
  }
  color(i: number): number {
    return this.u32[i * 5 + 4];
  }
}

/** Solid rectangles in the renderer's instance format. */
export class RectList extends InstanceList {
  constructor() {
    super(RECT_INSTANCE_BYTES);
  }

  push(x: number, y: number, width: number, height: number, color: number): void {
    if (width <= 0 || height <= 0) return;
    const f = this.next() * 5;
    this.f32[f] = x;
    this.f32[f + 1] = y;
    this.f32[f + 2] = width;
    this.f32[f + 3] = height;
    this.u32[f + 4] = color;
  }

  /** x, y, width, height of rectangle i. */
  rect(i: number): [number, number, number, number] {
    const f = i * 5;
    return [this.f32[f], this.f32[f + 1], this.f32[f + 2], this.f32[f + 3]];
  }
  color(i: number): number {
    return this.u32[i * 5 + 4];
  }
}

export interface ImageItem {
  /** Package part of the image (resolve bytes through the source document). */
  part: string;
  /** Package part of the SVG this picture shows, when it is a vector drawing that can be edited. */
  svg?: string;
  /** For an embedded stored drawing (`![[...]]` in Markdown): what was written between the brackets. The drawing is that document's, not this one's. */
  embed?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Drawn behind text (floating images marked "behind text"). */
  behind: boolean;
  /** The drawing in the document this shows (so a click can select it); left off what is sent to the page. */
  drawing?: Drawing;
}

/** A laid-out line, for hit testing and caret placement when editing. */
export interface LineRecord {
  paragraph: Paragraph;
  /** Range in the paragraph's visible text (list labels excluded). */
  start: number;
  end: number;
  x: number;
  y: number;
  width: number;
  height: number;
  baseline: number;
  /** Left edge of the column the line was laid out in; caret x = column + stops[offset - start]. */
  column: number;
  /** Width of the column, for a line of the body in a section with columns (not for table cells or a page with one column). */
  columnWidth?: number;
  /** Caret positions relative to `column`, for visible offsets start..end inclusive. */
  stops: Float32Array;
  /** The check box of a task list item (x from `column`, y from the line's top). */
  box?: { x: number; y: number; size: number; checked: boolean };
  /** Visible to model offsets for the paragraph (shared by its lines). */
  spans: SourceSpan[];
  /** The line ends in a space or break that belongs to it. */
  trailingSpace: boolean;
  /** Last line of its paragraph. */
  last: boolean;
}

let nextPageId = 1;

export class PageLayout {
  /** Unique for the session: pages keep their id when re-layout moves them. */
  readonly id = nextPageId++;
  /** Pagination state where the body starts (body pages only). */
  start?: PageStart;
  readonly glyphs = new Map<string, GlyphList>();
  /** Shading and highlighting, drawn behind text. */
  readonly background = new RectList();
  /** Underlines, strikethroughs, borders, drawn over text. */
  readonly foreground = new RectList();
  readonly images: ImageItem[] = [];
  readonly lines: LineRecord[] = [];

  constructor(
    /** Position in the document; changes when pages before it are added or removed. */
    public index: number,
    readonly width: number,
    readonly height: number,
    /** Index into DocumentLayout.sections. */
    readonly section: number,
    /** Page number as displayed (sections may restart numbering). */
    public number: number,
  ) {}

  glyphList(font: ResolvedFont, metrics: FaceMetrics): GlyphList {
    let list = this.glyphs.get(font.key);
    if (!list) {
      list = new GlyphList(font, metrics);
      this.glyphs.set(font.key, list);
    }
    return list;
  }

  /** Adds another layout's content (a header/footer overlay) on top of this page's. */
  append(other: PageLayout): void {
    for (const list of other.glyphs.values()) this.glyphList(list.font, list.metrics).append(list);
    this.background.append(other.background);
    this.foreground.append(other.foreground);
    this.images.push(...other.images);
    this.lines.push(...other.lines);
  }

  get glyphCount(): number {
    let n = 0;
    for (const list of this.glyphs.values()) n += list.count;
    return n;
  }
}
