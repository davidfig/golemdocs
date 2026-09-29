// A page of a document (§7.7.3.3): geometry with inherited attributes, content streams and
// resources.

import { PdfDict, PdfRef, PdfStream, type PdfObject } from './core/objects.ts';
import { parseContent, serializeContent, type Operation } from './content/content.ts';
import type { PdfDocument } from './document.ts';
import { extractText, type ExtractOptions, type PageText } from './text/extract.ts';
import { PageDrawing, type DrawOptions } from './write/draw.ts';
import { addLink, type LinkTarget } from './write/navigation.ts';

/** Page attributes that may be inherited from ancestor page tree nodes. */
export const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const;

/** [x0, y0, x1, y1], normalized so x0 <= x1 and y0 <= y1. */
export type Box = [number, number, number, number];

export class PdfPage {
  constructor(
    readonly doc: PdfDocument,
    readonly ref: PdfRef,
    readonly dict: PdfDict,
  ) {}

  /** Zero-based position in the document. */
  get index(): number {
    return this.doc.pages.findIndex((p) => p.ref.equals(this.ref));
  }

  /** An attribute from this page or the nearest ancestor that has it. */
  inherited(key: string): PdfObject | undefined {
    let node: PdfDict | undefined = this.dict;
    for (let depth = 0; node && depth < 64; depth++) {
      const v = node.get(key);
      if (v !== undefined) return v;
      node = this.doc.dict(node.get('Parent'));
    }
    return undefined;
  }

  /** Copies inherited attributes onto the page itself (before moving it within or out of the tree). */
  materializeInherited(): void {
    for (const key of INHERITABLE) {
      if (!this.dict.has(key)) {
        const v = this.inherited(key);
        if (v !== undefined) this.dict.set(key, v);
      }
    }
  }

  private box(key: string): Box | undefined {
    const a = this.doc.array(key === 'MediaBox' || key === 'CropBox' ? this.inherited(key) : this.dict.get(key));
    if (!a || a.length !== 4) return undefined;
    const n = a.map((x) => this.doc.number(x));
    if (n.some((x) => x === undefined)) return undefined;
    const [x0, y0, x1, y1] = n as number[];
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  }

  /** The page's full extent (defaults to US Letter when missing, as viewers do). */
  get mediaBox(): Box {
    return this.box('MediaBox') ?? [0, 0, 612, 792];
  }

  set mediaBox(b: Box) {
    this.dict.set('MediaBox', [...b]);
  }

  /** The visible region: CropBox clipped to MediaBox. */
  get cropBox(): Box {
    const m = this.mediaBox;
    const c = this.box('CropBox');
    if (!c) return m;
    const r: Box = [Math.max(m[0], c[0]), Math.max(m[1], c[1]), Math.min(m[2], c[2]), Math.min(m[3], c[3])];
    return r[0] < r[2] && r[1] < r[3] ? r : m;
  }

  set cropBox(b: Box) {
    this.dict.set('CropBox', [...b]);
  }

  /** Clockwise display rotation: 0, 90, 180 or 270. */
  get rotation(): number {
    const r = this.doc.number(this.inherited('Rotate')) ?? 0;
    return (((Math.round(r / 90) * 90) % 360) + 360) % 360;
  }

  set rotation(deg: number) {
    this.dict.set('Rotate', (((Math.round(deg / 90) * 90) % 360) + 360) % 360);
  }

  /** Displayed size in points (crop box, rotation applied). */
  get size(): { width: number; height: number } {
    const [x0, y0, x1, y1] = this.cropBox;
    const r = this.rotation;
    return r === 90 || r === 270 ? { width: y1 - y0, height: x1 - x0 } : { width: x1 - x0, height: y1 - y0 };
  }

  /**
   * Maps a point in default user space (y up) to displayed page coordinates (points from the
   * top-left of the rotated crop box, y down).
   */
  toDisplay(x: number, y: number): [number, number] {
    const [x0, y0, x1, y1] = this.cropBox;
    switch (this.rotation) {
      case 90:
        return [y - y0, x - x0];
      case 180:
        return [x1 - x, y - y0];
      case 270:
        return [y1 - y, x1 - x];
      default:
        return [x - x0, y1 - y];
    }
  }

  /** The page's resource dictionary (inherited if need be), created if absent. */
  get resources(): PdfDict {
    let r = this.doc.dict(this.inherited('Resources'));
    if (!r) {
      r = new PdfDict();
      this.dict.set('Resources', r);
    }
    return r;
  }

  /** The content streams, in order. */
  get contentStreams(): PdfStream[] {
    const c = this.doc.resolve(this.dict.get('Contents'));
    const list = Array.isArray(c) ? c.map((x) => this.doc.resolve(x)) : [c];
    return list.filter((s): s is PdfStream => s instanceof PdfStream);
  }

  /** All content streams decoded and joined (streams may split anywhere between tokens). */
  contentData(): Uint8Array {
    const parts = this.contentStreams.map((s) => this.doc.streamData(s));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      out[o + p.length] = 0x0a;
      o += p.length + 1;
    }
    return out;
  }

  operations(): Operation[] {
    return parseContent(this.contentData());
  }

  /** Replaces the page's content with a single stream. */
  setContent(content: Uint8Array | Operation[]): void {
    const data = content instanceof Uint8Array ? content : serializeContent(content);
    this.dict.set('Contents', this.doc.add(new PdfStream(new PdfDict(), data)));
  }

  /**
   * Adds content drawn over (or under) the existing content. Over, the existing content is
   * wrapped in q/Q so its graphics state can't leak into the addition.
   */
  addContent(content: Uint8Array | Operation[], under = false): void {
    const data = content instanceof Uint8Array ? content : serializeContent(content);
    const existing = this.doc.resolve(this.dict.get('Contents'));
    const refs: PdfObject[] = Array.isArray(existing) ? [...existing] : this.dict.get('Contents') !== undefined ? [this.dict.get('Contents')!] : [];
    const stream = (bytes: string | Uint8Array) =>
      this.doc.add(new PdfStream(new PdfDict(), typeof bytes === 'string' ? Uint8Array.from(bytes, (c) => c.charCodeAt(0)) : bytes));
    if (under) this.dict.set('Contents', [stream(data), ...refs]);
    else if (!refs.length) this.dict.set('Contents', stream(data));
    else this.dict.set('Contents', [stream('q\n'), ...refs, stream('\nQ\n'), stream(data)]);
  }

  /** Adds a resource (font, XObject, ...) under a fresh name and returns the name. */
  addResource(category: 'Font' | 'XObject' | 'ExtGState' | 'ColorSpace' | 'Pattern' | 'Shading', value: PdfObject, prefix = category[0]): string {
    const res = this.resources;
    let cat = this.doc.dict(res.get(category));
    if (!cat) {
      cat = new PdfDict();
      res.set(category, cat);
    }
    // Reuse the name if this exact object is already there.
    for (const [k, v] of cat) if (v === value || (v instanceof PdfRef && v.equals(value))) return k;
    let i = cat.size + 1;
    while (cat.has(`${prefix}${i}`)) i++;
    const name = `${prefix}${i}`;
    cat.set(name, value);
    return name;
  }

  /**
   * Starts drawing on the page. Call `finish()` on the result when done (saving the document
   * finishes any drawing still open).
   */
  draw(options: DrawOptions = {}): PageDrawing {
    const d = new PageDrawing(this, options);
    this.doc.onBeforeSave(() => d.finish());
    return d;
  }

  /** Adds a clickable link over a rectangle in user space ([x0, y0, x1, y1], y up). */
  addLink(rect: Box, target: LinkTarget): PdfRef {
    return addLink(this, rect, target);
  }

  /** Text on the page, as positioned items and as plain text. */
  extractText(options?: ExtractOptions): PageText {
    return extractText(this, options);
  }

  /** The page's annotations (resolved dictionaries). */
  get annotations(): PdfDict[] {
    return (this.doc.array(this.dict.get('Annots')) ?? []).map((a) => this.doc.dict(a)).filter((d): d is PdfDict => !!d);
  }
}
