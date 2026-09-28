import type { FontLibrary, FontRequest } from '../text/fontLibrary.ts';
import { TextBatch } from '../text/textBatch.ts';

/** Word's defaults: US Letter with 1" margins, in points. */
export const LETTER = {
  width: 612,
  height: 792,
  margin: { top: 72, right: 72, bottom: 72, left: 72 },
  /** Gray space between pages on screen. */
  gap: 18,
};
export type PageSetup = typeof LETTER;

/**
 * A laid-out page in document space (points). Its text batches use the page's top-left as
 * their origin, so glyph positions stay precise however far down the document it is.
 * Pages are the unit of culling: only pages overlapping the view are drawn or uploaded.
 */
export class Page {
  readonly batches: TextBatch[] = [];
  private readonly byKey = new Map<string, TextBatch>();

  constructor(
    private _x: number,
    private _y: number,
    readonly width: number,
    public height: number,
    /** Draw a white sheet behind the text. */
    readonly background = true,
  ) {}

  /** The batch on this page for a font request. The face must already be loaded. */
  batch(library: FontLibrary, request: FontRequest): TextBatch {
    const resolved = library.resolve(request);
    let batch = this.byKey.get(resolved.key);
    if (!batch) {
      const face = library.get(resolved.face);
      if (!face) throw new Error(`${resolved.key} used before it was loaded`);
      batch = new TextBatch(
        face,
        { skew: resolved.syntheticItalic ? 0.2 : 0, embolden: resolved.syntheticBold ? 0.02 : 0 },
        this._x,
        this._y,
      );
      this.byKey.set(resolved.key, batch);
      this.batches.push(batch);
    }
    return batch;
  }

  get x(): number {
    return this._x;
  }

  get y(): number {
    return this._y;
  }

  /**
   * Moves the page. Glyphs are stored relative to the page, so this only updates batch
   * origins: no re-layout and no GPU upload.
   */
  moveTo(x: number, y: number): void {
    this._x = x;
    this._y = y;
    for (const batch of this.batches) {
      batch.originX = x;
      batch.originY = y;
    }
  }

  get glyphCount(): number {
    let count = 0;
    for (const batch of this.batches) count += batch.count;
    return count;
  }
}
