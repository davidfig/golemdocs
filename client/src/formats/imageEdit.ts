// Changing a picture: quarter turns, flips, crop, resize and colour adjustments, done with the
// browser's canvas. Each takes a picture file and gives a new one of the same type (JPEG and WebP are
// recompressed, so repeated edits lose a little each time; PNG doesn't).

import { decodeImage, encodeCanvas, makeCanvas } from './imageCodec.ts';
import type { OutputType } from './imageCodec.ts';
import { boxOf, paintShape, pixelBlock } from './imageDraw.ts';
import type { Shape } from './imageDraw.ts';
import { adjustPixels, applyEffect, clampBox, tooBig } from './imagePixels.ts';
import type { Adjustments, Effect } from './imagePixels.ts';
import { sniffImage } from './images.ts';
import { t } from '../i18n/index.ts';

export type ImageEdit =
  /** Clockwise quarter turns. */
  | { op: 'rotate'; turns: 1 | 2 | 3 }
  | { op: 'flip'; axis: 'horizontal' | 'vertical' }
  /** A box in the picture's pixels. */
  | { op: 'crop'; x: number; y: number; width: number; height: number }
  | { op: 'resize'; width: number; height: number }
  | ({ op: 'adjust' } & Adjustments)
  | { op: 'effect'; effect: Effect }
  /** Shapes sketched over the picture, in its pixels. */
  | { op: 'draw'; shapes: Shape[] };

export interface Edited {
  bytes: Uint8Array;
  type: OutputType;
  width: number;
  height: number;
}

export async function applyImageEdit(bytes: Uint8Array, edit: ImageEdit): Promise<Edited> {
  const image = sniffImage(bytes);
  const type: OutputType = image?.type === 'jpeg' || image?.type === 'webp' ? image.type : 'png';
  const bitmap = await decodeImage(bytes, image?.type);
  try {
    const { width, height } = bitmap;
    let out: ReturnType<typeof makeCanvas>;
    switch (edit.op) {
      case 'rotate': {
        const quarter = edit.turns % 2 === 1;
        out = makeCanvas(quarter ? height : width, quarter ? width : height);
        out.context.translate(out.canvas.width / 2, out.canvas.height / 2);
        out.context.rotate((edit.turns * Math.PI) / 2);
        out.context.drawImage(bitmap, -width / 2, -height / 2);
        break;
      }
      case 'flip':
        out = makeCanvas(width, height);
        if (edit.axis === 'horizontal') out.context.setTransform(-1, 0, 0, 1, width, 0);
        else out.context.setTransform(1, 0, 0, -1, 0, height);
        out.context.drawImage(bitmap, 0, 0);
        break;
      case 'crop': {
        const box = clampBox(edit, width, height);
        out = makeCanvas(box.width, box.height);
        out.context.drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
        break;
      }
      case 'resize': {
        if (tooBig(edit.width, edit.height)) throw new Error(t('app.imageTooBig'));
        out = makeCanvas(edit.width, edit.height);
        out.context.imageSmoothingEnabled = true;
        out.context.imageSmoothingQuality = 'high';
        out.context.drawImage(bitmap, 0, 0, out.canvas.width, out.canvas.height);
        break;
      }
      case 'draw':
        out = makeCanvas(width, height);
        out.context.drawImage(bitmap, 0, 0);
        for (const shape of edit.shapes) {
          if (shape.tool === 'pixelate') pixelate(out, shape);
          else paintShape(out.context, shape);
        }
        break;
      case 'effect': {
        out = makeCanvas(width, height);
        out.context.drawImage(bitmap, 0, 0);
        const pixels = out.context.getImageData(0, 0, width, height);
        applyEffect(pixels.data, width, height, edit.effect);
        out.context.putImageData(pixels, 0, 0);
        break;
      }
      case 'adjust': {
        out = makeCanvas(width, height);
        out.context.drawImage(bitmap, 0, 0);
        const pixels = out.context.getImageData(0, 0, width, height);
        adjustPixels(pixels.data, edit);
        out.context.putImageData(pixels, 0, 0);
        break;
      }
    }
    return { bytes: await encodeCanvas(out.canvas, type), type, width: out.canvas.width, height: out.canvas.height };
  } finally {
    bitmap.close();
  }
}

/** Blocks out the part of the picture under a pixelate shape: it is shrunk to a few blocks and scaled back up sharp. */
function pixelate(target: ReturnType<typeof makeCanvas>, shape: Shape): void {
  const box = clampBox(boxOf(shape), target.canvas.width, target.canvas.height);
  const block = pixelBlock(shape.width);
  const small = makeCanvas(Math.ceil(box.width / block), Math.ceil(box.height / block));
  small.context.imageSmoothingEnabled = true;
  small.context.imageSmoothingQuality = 'high';
  small.context.drawImage(target.canvas as CanvasImageSource, box.x, box.y, box.width, box.height, 0, 0, small.canvas.width, small.canvas.height);
  target.context.imageSmoothingEnabled = false;
  target.context.drawImage(small.canvas as CanvasImageSource, 0, 0, small.canvas.width, small.canvas.height, box.x, box.y, box.width, box.height);
  target.context.imageSmoothingEnabled = true;
}
