// Glyph outlines as the font programs embedded in a PDF draw them: closed contours of lines and
// quadratic or cubic Béziers, in whatever units the program uses until `transformOutline` maps
// them to text space (ems, y up).

/** One curve of a contour: its points flattened, the start point first (2 for a line, 3 for a quadratic, 4 for a cubic). */
export interface Segment {
  points: number[];
}

/** A closed contour: each segment starts where the previous one ended, and the last ends at the first's start. */
export type Contour = Segment[];

export type Outline = Contour[];

/** Builds an outline from pen moves, closing each contour where the next one starts. */
export class OutlineBuilder {
  readonly contours: Outline = [];
  private contour: Contour | null = null;
  private x = 0;
  private y = 0;
  private startX = 0;
  private startY = 0;

  moveTo(x: number, y: number): void {
    this.close();
    this.contour = [];
    this.x = this.startX = x;
    this.y = this.startY = y;
  }

  lineTo(x: number, y: number): void {
    if (!this.contour) this.moveTo(this.x, this.y);
    if (x === this.x && y === this.y) return;
    this.contour!.push({ points: [this.x, this.y, x, y] });
    this.x = x;
    this.y = y;
  }

  quadTo(cx: number, cy: number, x: number, y: number): void {
    if (!this.contour) this.moveTo(this.x, this.y);
    this.contour!.push({ points: [this.x, this.y, cx, cy, x, y] });
    this.x = x;
    this.y = y;
  }

  curveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    if (!this.contour) this.moveTo(this.x, this.y);
    this.contour!.push({ points: [this.x, this.y, c1x, c1y, c2x, c2y, x, y] });
    this.x = x;
    this.y = y;
  }

  /** Ends the current contour, joining it back to its start with a line if it doesn't end there. */
  close(): void {
    const contour = this.contour;
    if (!contour) return;
    if (this.x !== this.startX || this.y !== this.startY) contour.push({ points: [this.x, this.y, this.startX, this.startY] });
    if (contour.length) this.contours.push(contour);
    this.contour = null;
    this.x = this.startX;
    this.y = this.startY;
  }

  /** The finished outline. */
  done(): Outline {
    this.close();
    return this.contours;
  }

  get currentX(): number {
    return this.x;
  }

  get currentY(): number {
    return this.y;
  }
}

/** The outline with the affine matrix [a b c d e f] applied to every point. */
export function transformOutline(outline: Outline, m: readonly number[]): Outline {
  const [a, b, c, d, e, f] = m;
  return outline.map((contour) =>
    contour.map((s) => {
      const p = s.points.slice();
      for (let i = 0; i < p.length; i += 2) {
        const x = p[i];
        const y = p[i + 1];
        p[i] = a * x + c * y + e;
        p[i + 1] = b * x + d * y + f;
      }
      return { points: p };
    }),
  );
}

/** An outline from an SVG path of M, L, Q and Z commands (what `TrueTypeFont.glyphPath` returns). */
export function outlineFromPath(path: string): Outline {
  const out = new OutlineBuilder();
  for (const [, cmd, args] of path.matchAll(/([MLQZ])([^MLQZ]*)/g)) {
    const n = args.trim() ? args.trim().split(/[\s,]+/).map(Number) : [];
    if (cmd === 'M') out.moveTo(n[0], n[1]);
    else if (cmd === 'L') for (let i = 0; i + 1 < n.length; i += 2) out.lineTo(n[i], n[i + 1]);
    else if (cmd === 'Q') for (let i = 0; i + 3 < n.length; i += 4) out.quadTo(n[i], n[i + 1], n[i + 2], n[i + 3]);
    else out.close();
  }
  return out.done();
}

/** The outline's bounding box [x0, y0, x1, y1] (of its control points: never smaller than the shape), or null if empty. */
export function outlineBounds(outline: Outline): [number, number, number, number] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const contour of outline) {
    for (const s of contour) {
      for (let i = 0; i < s.points.length; i += 2) {
        x0 = Math.min(x0, s.points[i]);
        x1 = Math.max(x1, s.points[i]);
        y0 = Math.min(y0, s.points[i + 1]);
        y1 = Math.max(y1, s.points[i + 1]);
      }
    }
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}
