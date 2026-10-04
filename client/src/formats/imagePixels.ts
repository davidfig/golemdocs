// The arithmetic of picture editing, apart from any canvas so it can be tested: colour adjustments
// on RGBA pixels, and sizes and crop boxes.

/** Each -100 to 100; 0 leaves the picture as it is. */
export interface Adjustments {
  brightness: number;
  contrast: number;
  saturation: number;
}

export const NO_ADJUSTMENTS: Adjustments = { brightness: 0, contrast: 0, saturation: 0 };

export const isNeutral = (a: Adjustments): boolean => a.brightness === 0 && a.contrast === 0 && a.saturation === 0;

/**
 * Brightness, contrast and saturation on RGBA bytes, in place (alpha is left alone). Brightness adds up to
 * a whole range, contrast is the usual pivot around mid-grey, and saturation blends each pixel with its own
 * luminance (-100 is grey, +100 twice as colourful).
 */
export function adjustPixels(data: Uint8ClampedArray, a: Adjustments): void {
  if (isNeutral(a)) return;
  const add = a.brightness * 2.55;
  const c = a.contrast * 2.55;
  const contrast = (259 * (c + 255)) / (255 * (259 - c));
  const saturation = 1 + a.saturation / 100;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    if (saturation !== 1) {
      const grey = 0.299 * r + 0.587 * g + 0.114 * b;
      r = grey + (r - grey) * saturation;
      g = grey + (g - grey) * saturation;
      b = grey + (b - grey) * saturation;
    }
    data[i] = contrast * (r + add - 128) + 128;
    data[i + 1] = contrast * (g + add - 128) + 128;
    data[i + 2] = contrast * (b + add - 128) + 128;
  }
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A crop box kept inside a picture of the given size, whole pixels, at least one pixel across. */
export function clampBox(box: Box, width: number, height: number): Box {
  const x = Math.min(Math.max(Math.round(box.x), 0), width - 1);
  const y = Math.min(Math.max(Math.round(box.y), 0), height - 1);
  return { x, y, width: Math.min(Math.max(Math.round(box.width), 1), width - x), height: Math.min(Math.max(Math.round(box.height), 1), height - y) };
}

/**
 * The largest box of the given shape (width over height) that fits inside `box`, keeping the corner or
 * edge named by `anchor` where it is: how a crop box takes on a fixed shape.
 */
export function boxWithAspect(box: Box, aspect: number, anchor: 'center' | 'topLeft' = 'center'): Box {
  let width = box.width;
  let height = width / aspect;
  if (height > box.height) {
    height = box.height;
    width = height * aspect;
  }
  const x = anchor === 'center' ? box.x + (box.width - width) / 2 : box.x;
  const y = anchor === 'center' ? box.y + (box.height - height) / 2 : box.y;
  return { x, y, width, height };
}

/** A new size for a picture when one side is set, keeping its shape when `keepShape`. Whole pixels, at least 1. */
export function resizedTo(width: number, height: number, set: { width?: number; height?: number }, keepShape: boolean): { width: number; height: number } {
  let w = set.width ?? width;
  let h = set.height ?? height;
  if (keepShape) {
    if (set.width !== undefined) h = (set.width * height) / width;
    else if (set.height !== undefined) w = (set.height * width) / height;
  }
  return { width: Math.max(Math.round(w), 1), height: Math.max(Math.round(h), 1) };
}

/** The largest number of pixels a picture may have (a canvas can't be bigger than this in most browsers). */
export const MAX_PIXELS = 100_000_000;
export const MAX_SIDE = 16_384;

export const tooBig = (width: number, height: number): boolean => width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS;

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';

/**
 * A crop box after the pointer moved by (dx, dy) pixels while holding one of its handles (or the box
 * itself, `move`). The box stays inside `bounds`, at least `min` pixels across, and keeps its shape
 * (width over height) when `aspect` is given: the corner or edge opposite the handle holds still.
 */
export function dragBox(start: Box, handle: Handle, dx: number, dy: number, bounds: { width: number; height: number }, aspect: number | null, min = 8): Box {
  const { width: W, height: H } = bounds;
  if (handle === 'move') {
    return { ...start, x: Math.min(Math.max(start.x + dx, 0), W - start.width), y: Math.min(Math.max(start.y + dy, 0), H - start.height) };
  }
  const floor = Math.min(min, W, H);
  let left = start.x;
  let right = start.x + start.width;
  let top = start.y;
  let bottom = start.y + start.height;
  if (handle.includes('w')) left = Math.min(Math.max(left + dx, 0), right - floor);
  if (handle.includes('e')) right = Math.min(Math.max(right + dx, left + floor), W);
  if (handle.includes('n')) top = Math.min(Math.max(top + dy, 0), bottom - floor);
  if (handle.includes('s')) bottom = Math.min(Math.max(bottom + dy, top + floor), H);
  if (aspect === null) return { x: left, y: top, width: right - left, height: bottom - top };

  let w = right - left;
  let h = bottom - top;
  const cx = start.x + start.width / 2;
  const cy = start.y + start.height / 2;
  if (handle === 'n' || handle === 's') {
    // The height leads; the width follows around the box's middle, as far as the picture allows.
    const room = 2 * Math.min(cx, W - cx);
    h = Math.min(h, room / aspect);
    w = h * aspect;
    left = cx - w / 2;
    right = cx + w / 2;
    if (handle === 'n') top = bottom - h;
    else bottom = top + h;
  } else if (handle === 'e' || handle === 'w') {
    const room = 2 * Math.min(cy, H - cy);
    w = Math.min(w, room * aspect);
    h = w / aspect;
    top = cy - h / 2;
    bottom = cy + h / 2;
    if (handle === 'w') left = right - w;
    else right = left + w;
  } else {
    // A corner: whichever side changed more (in proportion) leads; the opposite corner stays put.
    const fixedX = handle.includes('w') ? start.x + start.width : start.x;
    const fixedY = handle.includes('n') ? start.y + start.height : start.y;
    if (Math.abs(w - start.width) / start.width >= Math.abs(h - start.height) / start.height) h = w / aspect;
    else w = h * aspect;
    const maxW = handle.includes('w') ? fixedX : W - fixedX;
    const maxH = handle.includes('n') ? fixedY : H - fixedY;
    if (w > maxW) {
      w = maxW;
      h = w / aspect;
    }
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
    left = handle.includes('w') ? fixedX - w : fixedX;
    right = left + w;
    top = handle.includes('n') ? fixedY - h : fixedY;
    bottom = top + h;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The one-click effects: each changes the whole picture with no settings to ask for. */
export type Effect = 'grayscale' | 'sepia' | 'invert' | 'blur' | 'sharpen' | 'autoLevels';

/** A box blur of the given radius on RGBA bytes, horizontal then vertical, weighting colours by alpha so transparent pixels don't bleed in. */
export function blurPixels(data: Uint8ClampedArray, width: number, height: number, radius: number): void {
  const r = Math.max(Math.floor(radius), 0);
  if (r === 0 || width === 0 || height === 0) return;
  const line = new Float32Array(Math.max(width, height) * 4);
  const pass = (start: number, step: number, count: number) => {
    // A running sum over the window of `2r + 1` samples, clamped at the ends.
    let sr = 0, sg = 0, sb = 0, sa = 0;
    const at = (i: number) => start + Math.min(Math.max(i, 0), count - 1) * step;
    const add = (i: number, sign: number) => {
      const p = at(i);
      const a = data[p + 3];
      sr += sign * data[p] * a;
      sg += sign * data[p + 1] * a;
      sb += sign * data[p + 2] * a;
      sa += sign * a;
    };
    for (let i = -r; i <= r; i++) add(i, 1);
    const size = 2 * r + 1;
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      line[o] = sa ? sr / sa : 0;
      line[o + 1] = sa ? sg / sa : 0;
      line[o + 2] = sa ? sb / sa : 0;
      line[o + 3] = sa / size;
      add(i - r, -1);
      add(i + r + 1, 1);
    }
    for (let i = 0; i < count; i++) {
      const p = start + i * step;
      data[p] = line[i * 4];
      data[p + 1] = line[i * 4 + 1];
      data[p + 2] = line[i * 4 + 2];
      data[p + 3] = line[i * 4 + 3];
    }
  };
  for (let y = 0; y < height; y++) pass(y * width * 4, 4, width);
  for (let x = 0; x < width; x++) pass(x * 4, width * 4, height);
}

/** How far to blur for the "Blur" effect: about half a percent of the longer side, at least a pixel. */
export const blurRadius = (width: number, height: number): number => Math.max(1, Math.round(Math.max(width, height) / 200));

/** An effect on RGBA bytes, in place. Alpha is kept (except by Blur, which averages it). */
export function applyEffect(data: Uint8ClampedArray, width: number, height: number, effect: Effect): void {
  switch (effect) {
    case 'grayscale':
      for (let i = 0; i < data.length; i += 4) data[i] = data[i + 1] = data[i + 2] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      break;
    case 'sepia':
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        data[i] = 0.393 * r + 0.769 * g + 0.189 * b;
        data[i + 1] = 0.349 * r + 0.686 * g + 0.168 * b;
        data[i + 2] = 0.272 * r + 0.534 * g + 0.131 * b;
      }
      break;
    case 'invert':
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i];
        data[i + 1] = 255 - data[i + 1];
        data[i + 2] = 255 - data[i + 2];
      }
      break;
    case 'blur':
      blurPixels(data, width, height, blurRadius(width, height));
      break;
    case 'sharpen': {
      // An unsharp mask: add back what a blur takes away.
      const soft = new Uint8ClampedArray(data);
      blurPixels(soft, width, height, Math.max(1, Math.round(blurRadius(width, height) / 2)));
      for (let i = 0; i < data.length; i += 4) {
        for (let c = 0; c < 3; c++) data[i + c] = data[i + c] + 1.2 * (data[i + c] - soft[i + c]);
      }
      break;
    }
    case 'autoLevels': {
      // Stretch each colour so its darkest and lightest 0.5% of pixels reach black and white.
      const clip = Math.floor((data.length / 4) * 0.005);
      const ends: [number, number][] = [];
      for (let c = 0; c < 3; c++) {
        const histogram = new Uint32Array(256);
        for (let i = c; i < data.length; i += 4) histogram[data[i]]++;
        let low = 0;
        let seen = 0;
        while (low < 255 && seen + histogram[low] <= clip) seen += histogram[low++];
        let high = 255;
        seen = 0;
        while (high > low && seen + histogram[high] <= clip) seen += histogram[high--];
        ends.push([low, high]);
      }
      for (let i = 0; i < data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const [low, high] = ends[c];
          if (high > low) data[i + c] = ((data[i + c] - low) * 255) / (high - low);
        }
      }
      break;
    }
  }
}

/**
 * The pixels the paint bucket reaches from (x, y): a mask of 255 where a pixel's colour is within `tolerance` (0 to 255, the
 * largest difference in any channel, alpha included) of the one clicked. `contiguous` takes only pixels connected to the click
 * (a flood fill); otherwise every pixel of that colour in the picture.
 */
export function floodMask(data: Uint8ClampedArray, width: number, height: number, x: number, y: number, tolerance: number, contiguous = true): Uint8Array {
  const mask = new Uint8Array(width * height);
  const sx = Math.floor(x);
  const sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return mask;
  const at = (sy * width + sx) * 4;
  const [r, g, b, a] = [data[at], data[at + 1], data[at + 2], data[at + 3]];
  const near = (i: number): boolean => {
    const o = i * 4;
    return Math.abs(data[o] - r) <= tolerance && Math.abs(data[o + 1] - g) <= tolerance && Math.abs(data[o + 2] - b) <= tolerance && Math.abs(data[o + 3] - a) <= tolerance;
  };
  if (!contiguous) {
    for (let i = 0; i < width * height; i++) if (near(i)) mask[i] = 255;
    return mask;
  }
  // Spans of a row are filled at once, and the rows above and below are searched for more.
  const stack: number[] = [sy * width + sx];
  while (stack.length) {
    const start = stack.pop()!;
    const row = Math.floor(start / width);
    if (mask[start] || !near(start)) continue;
    let left = start % width;
    let right = left;
    while (left > 0 && !mask[row * width + left - 1] && near(row * width + left - 1)) left--;
    while (right < width - 1 && !mask[row * width + right + 1] && near(row * width + right + 1)) right++;
    for (let c = left; c <= right; c++) mask[row * width + c] = 255;
    for (const next of [row - 1, row + 1]) {
      if (next < 0 || next >= height) continue;
      let open = false;
      for (let c = left; c <= right; c++) {
        const i = next * width + c;
        const can = !mask[i] && near(i);
        if (can && !open) stack.push(i);
        open = can;
      }
    }
  }
  return mask;
}

/** Where the old picture goes on a canvas of another size: pinned to a side or corner, or in the middle. */
export type Anchor = 'nw' | 'n' | 'ne' | 'w' | 'center' | 'e' | 'sw' | 's' | 'se';

export const ANCHORS: readonly Anchor[] = ['nw', 'n', 'ne', 'w', 'center', 'e', 'sw', 's', 'se'];

/** The top-left of a `from`-sized picture on a `to`-sized canvas, in whole pixels (it may be negative, which crops). */
export function anchorOffset(from: { width: number; height: number }, to: { width: number; height: number }, anchor: Anchor): { x: number; y: number } {
  const spare = { x: to.width - from.width, y: to.height - from.height };
  // 'center' has letters of its own, so a side is read from the compass letters only.
  const compass = anchor === 'center' ? '' : anchor;
  const x = compass.endsWith('w') ? 0 : compass.endsWith('e') ? spare.x : Math.round(spare.x / 2);
  const y = compass.startsWith('n') ? 0 : compass.startsWith('s') ? spare.y : Math.round(spare.y / 2);
  return { x, y };
}

/**
 * The region of a fill grown into the soft edge of what bounds it. A line drawn with anti-aliasing has pixels along it that are a mix of its
 * colour and the colour beside it, further from the clicked colour than the tolerance allows, so a flood stops a pixel or two short and
 * leaves a gap. Each ring of `limits` adds the pixels touching the region that are within that distance (0 to 255) of the clicked colour:
 * the first ring takes most of the mix, the next only what is nearly the clicked colour, and the line's own colour is never reached.
 */
export function growMask(data: Uint8ClampedArray, width: number, height: number, mask: Uint8Array, x: number, y: number, limits: readonly number[] = [191, 127]): Uint8Array {
  const sx = Math.floor(x);
  const sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return mask;
  const o = (sy * width + sx) * 4;
  const seed = [data[o], data[o + 1], data[o + 2], data[o + 3]];
  const near = (i: number, limit: number): boolean => {
    const p = i * 4;
    return Math.abs(data[p] - seed[0]) <= limit && Math.abs(data[p + 1] - seed[1]) <= limit && Math.abs(data[p + 2] - seed[2]) <= limit && Math.abs(data[p + 3] - seed[3]) <= limit;
  };
  let current = mask;
  for (const limit of limits) {
    const next = current.slice();
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const i = py * width + px;
        if (current[i]) continue;
        const touching = (px > 0 && current[i - 1]) || (px < width - 1 && current[i + 1]) || (py > 0 && current[i - width]) || (py < height - 1 && current[i + width]);
        if (touching && near(i, limit)) next[i] = 255;
      }
    }
    current = next;
  }
  return current;
}

/** The brushes that change the pixels they pass over (see imageDraw.ts `EFFECT_TOOLS`). */
export type BrushEffect = 'smudge' | 'blurBrush' | 'sharpenBrush' | 'mixer' | 'dodge' | 'burn';

/** How much of its full effect a brush has at a distance from its centre: full in the middle, none at the edge, smooth between. */
const falloff = (distance: number, radius: number): number => {
  const t = 1 - distance / radius;
  return t <= 0 ? 0 : t * t * (3 - 2 * t);
};

/** The points a brush is stamped at along a path: close enough (a quarter of the radius apart) that the stamps run together. */
export function stampPoints(points: readonly { x: number; y: number }[], radius: number): { x: number; y: number }[] {
  const step = Math.max(1, radius / 4);
  const out: { x: number; y: number }[] = [];
  if (!points.length) return out;
  out.push(points[0]);
  // How far the path has run since the last stamp, carried round corners so the spacing stays even.
  let since = 0;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!length) continue;
    let at = step - since;
    while (at <= length) {
      out.push({ x: a.x + ((b.x - a.x) * at) / length, y: a.y + ((b.y - a.y) * at) / length });
      at += step;
    }
    since = length - (at - step);
  }
  return out;
}

/** The colour `#rrggbb` as red, green and blue. */
const rgbOf = (color: string): [number, number, number] => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
};

/**
 * Drags a brush along `points` over RGBA pixels, in place. `radius` is how far it reaches and `strength` (0 to 1) how strongly it works.
 * smudge: picks up the colour under the first stamp and drags it, losing some of it at each stamp the weaker the strength is.
 * mixer: the same, but what it starts with is `color`, so the paint spreads and mixes with what it passes over.
 * blurBrush and sharpenBrush: soften or sharpen under each stamp. dodge and burn: lighten or darken.
 */
export function brushStroke(data: Uint8ClampedArray, width: number, height: number, effect: BrushEffect, points: readonly { x: number; y: number }[], radius: number, strength: number, color = '#000000'): void {
  const r = Math.max(1, radius);
  const size = Math.ceil(r) * 2 + 1;
  const amount = Math.min(Math.max(strength, 0), 1);
  const carry = effect === 'smudge' || effect === 'mixer' ? new Float32Array(size * size * 4) : null;
  const [cr, cg, cb] = rgbOf(color);
  let first = true;
  for (const stamp of stampPoints(points, r)) {
    const x0 = Math.round(stamp.x) - Math.ceil(r);
    const y0 = Math.round(stamp.y) - Math.ceil(r);
    // The pixels under the stamp as they are now (for the effects that look at their neighbours).
    const before = effect === 'blurBrush' || effect === 'sharpenBrush' ? blurredPatch(data, width, height, x0, y0, size, Math.max(1, Math.round(r / 5))) : null;
    for (let py = 0; py < size; py++) {
      const y = y0 + py;
      if (y < 0 || y >= height) continue;
      for (let px = 0; px < size; px++) {
        const x = x0 + px;
        if (x < 0 || x >= width) continue;
        const w = falloff(Math.hypot(px - size / 2 + 0.5, py - size / 2 + 0.5), r);
        if (w <= 0) continue;
        const i = (y * width + x) * 4;
        const c = (py * size + px) * 4;
        if (carry) {
          if (first) {
            // Picked up where the stroke starts (a mixer starts with its own colour instead).
            if (effect === 'mixer') [carry[c], carry[c + 1], carry[c + 2], carry[c + 3]] = [cr, cg, cb, 255];
            else for (let k = 0; k < 4; k++) carry[c + k] = data[i + k];
            continue;
          }
          const give = w * (effect === 'mixer' ? 0.5 + amount / 2 : amount);
          for (let k = 0; k < 4; k++) {
            const here = data[i + k];
            const held = carry[c + k];
            data[i + k] = here + (held - here) * give;
            // What is carried on takes up some of what it passed over: the weaker the strength, the more.
            carry[c + k] = held + (here - held) * (1 - amount) * w * 0.5;
          }
        } else if (before) {
          for (let k = 0; k < 3; k++) {
            const soft = before[(py * size + px) * 4 + k];
            const here = data[i + k];
            data[i + k] = effect === 'blurBrush' ? here + (soft - here) * w * amount : here + (here - soft) * w * amount * 2;
          }
        } else {
          // dodge lightens, burn darkens: a share of the way to white or black.
          const target = effect === 'dodge' ? 255 : 0;
          for (let k = 0; k < 3; k++) data[i + k] += (target - data[i + k]) * w * amount * 0.25;
        }
      }
    }
    first = false;
  }
}

/** A box blur of a square patch of the pixels (the colours only, 4 values to a pixel with the last unused), for the blur and sharpen brushes. */
function blurredPatch(data: Uint8ClampedArray, width: number, height: number, x0: number, y0: number, size: number, radius: number): Float32Array {
  const out = new Float32Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sums = [0, 0, 0];
      let n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const y = y0 + py + dy;
        if (y < 0 || y >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const x = x0 + px + dx;
          if (x < 0 || x >= width) continue;
          const i = (y * width + x) * 4;
          sums[0] += data[i];
          sums[1] += data[i + 1];
          sums[2] += data[i + 2];
          n++;
        }
      }
      const o = (py * size + px) * 4;
      if (n) [out[o], out[o + 1], out[o + 2]] = [sums[0] / n, sums[1] / n, sums[2] / n];
    }
  }
  return out;
}
