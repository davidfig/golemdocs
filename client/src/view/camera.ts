/** CSS pixels per point at 100% zoom (Word: 1pt = 1/72in, 96 CSS px per inch). */
export const CSS_PX_PER_POINT = 96 / 72;

/**
 * Maps document space (points, y down) to the canvas. Changing it never touches glyph
 * buffers, only uniforms, which is what makes zoom and scroll cheap.
 */
export class Camera {
  /** Document point shown at the canvas's top-left corner. */
  x = 0;
  y = 0;
  /** 1 = 100%. */
  zoom = 1;
  minZoom = 0.05;
  maxZoom = 64;
  /** Canvas size in device pixels, and device pixels per CSS pixel. */
  width = 1;
  height = 1;
  dpr = 1;

  /** Device pixels per document point. */
  get scale(): number {
    return this.zoom * CSS_PX_PER_POINT * this.dpr;
  }

  /** Zooms by `factor`, keeping the document point under (cssX, cssY) fixed on screen. */
  zoomAt(cssX: number, cssY: number, factor: number): void {
    const before = this.toDocument(cssX, cssY);
    this.zoom = Math.min(Math.max(this.zoom * factor, this.minZoom), this.maxZoom);
    const after = this.toDocument(cssX, cssY);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  /** Scrolls by a distance in CSS pixels. */
  panBy(cssDx: number, cssDy: number): void {
    const pointsPerCss = 1 / (this.zoom * CSS_PX_PER_POINT);
    this.x += cssDx * pointsPerCss;
    this.y += cssDy * pointsPerCss;
  }

  toDocument(cssX: number, cssY: number): { x: number; y: number } {
    const pointsPerCss = 1 / (this.zoom * CSS_PX_PER_POINT);
    return { x: this.x + cssX * pointsPerCss, y: this.y + cssY * pointsPerCss };
  }
}
