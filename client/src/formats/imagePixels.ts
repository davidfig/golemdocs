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
