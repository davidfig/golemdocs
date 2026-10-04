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
  minZoom = 0.01;
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

  /** Zooms and scrolls so a document rectangle fills the view (CSS size), with padding in CSS px. */
  fit(bounds: { x: number; y: number; width: number; height: number }, cssWidth: number, cssHeight: number, padding = 24): void {
    const zoomX = (cssWidth - padding * 2) / (bounds.width * CSS_PX_PER_POINT);
    const zoomY = (cssHeight - padding * 2) / (bounds.height * CSS_PX_PER_POINT);
    this.zoom = Math.min(Math.max(Math.min(zoomX, zoomY), this.minZoom), this.maxZoom);
    const pointsPerCss = 1 / (this.zoom * CSS_PX_PER_POINT);
    this.x = bounds.x + bounds.width / 2 - (cssWidth / 2) * pointsPerCss;
    this.y = bounds.y + bounds.height / 2 - (cssHeight / 2) * pointsPerCss;
  }

  /**
   * Keeps the view over the document: per axis the view may extend at most `padding` CSS px past
   * `bounds`, and a document smaller than the view is centered instead.
   */
  clamp(bounds: { x: number; y: number; width: number; height: number }, cssWidth: number, cssHeight: number, padding = 24): void {
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const pointsPerCss = 1 / (this.zoom * CSS_PX_PER_POINT);
    this.x = clampAxis(this.x, bounds.x, bounds.width, cssWidth * pointsPerCss, padding * pointsPerCss);
    this.y = clampAxis(this.y, bounds.y, bounds.height, cssHeight * pointsPerCss, padding * pointsPerCss);
  }

  /**
   * Keeps the view over text that starts at the top-left corner, as a text file does: the view never shows anything before `bounds`,
   * may run `padding` CSS px past its end, and text smaller than the view sits at its start rather than in the middle.
   */
  clampToStart(bounds: { x: number; y: number; width: number; height: number }, cssWidth: number, cssHeight: number, padding = 24): void {
    const pointsPerCss = 1 / (this.zoom * CSS_PX_PER_POINT);
    this.x = clampAxisToStart(this.x, bounds.x, bounds.width, cssWidth * pointsPerCss, padding * pointsPerCss);
    this.y = clampAxisToStart(this.y, bounds.y, bounds.height, cssHeight * pointsPerCss, padding * pointsPerCss);
  }

  toDocument(cssX: number, cssY: number): { x: number; y: number } {
    const pointsPerCss = 1 / (this.zoom * CSS_PX_PER_POINT);
    return { x: this.x + cssX * pointsPerCss, y: this.y + cssY * pointsPerCss };
  }
}

/** Clamps one axis of the view origin so the view stays within the content plus padding (all in points); centers when it can't fit. */
function clampAxis(origin: number, start: number, size: number, view: number, pad: number): number {
  const min = start - pad;
  const max = start + size + pad - view;
  return max < min ? (min + max) / 2 : Math.min(Math.max(origin, min), max);
}

/** Clamps one axis of the view origin to at least the content's start and at most its end plus padding less the view (all in points). */
function clampAxisToStart(origin: number, start: number, size: number, view: number, pad: number): number {
  return Math.max(Math.min(origin, start + size + pad - view), start);
}
